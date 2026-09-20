// ttyctl: the handful of terminal/fd syscalls Node does not expose.
// N-API C, no C++ and no node-addon-api. Every function validates its
// arguments, never blocks, and throws a JS Error with `code` (errno name)
// and `errno` on failure.
//
//   lflag(fd)                     -> {icanon, isig, echo}   tcgetattr(); on a PTY master Linux returns the slave's termios
//   openSlave(ptsPath)            -> fd                     open(O_RDWR|O_NOCTTY|O_CLOEXEC); O_NOCTTY so we never acquire a controlling tty
//   closeFd(fd)                   -> undefined              close()
//   inq(fd)                       -> number                 ioctl(TIOCINQ); meaningful on the SLAVE fd only (reads 0 on a master)
//   tcgetpgrp(fd)                 -> pid                    foreground process group of the terminal
//   flock(fd, exclusive, nonBlock)-> boolean                false only when non-blocking and already locked elsewhere
//   peerUid(fd)                   -> uid                    getsockopt(SO_PEERCRED) on a connected AF_UNIX socket
//
// macOS-only (absent on Linux, where /proc/self/stat answers the same questions):
//
//   procInfo(pid)  -> {startSec, startUsec, pgid, ppid, sid, status} | null
//   listPids()     -> number[]
//
// macOS has no /proc, so `darwin.js` needs libproc. It is inlined here rather than in a second
// native module because ttyctl is already a hard dependency that must build before ccs runs, and
// a second addon would be a second thing to build, ship and fail. On Linux these two exports do
// not exist at all, so nothing about the existing Linux addon changes.
//
//   procInfo() is hot: `procState` is polled every 5 ms by the holder. libproc is a direct
//   syscall, so this stays microseconds -- shelling out to `ps` would be ~1.4 ms per call and is
//   also only second-precise, which would make two processes started in the same second
//   indistinguishable to `isSameProcess`.
#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <termios.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/ucred.h>
#include <sys/un.h>   // SOL_LOCAL / LOCAL_PEERCRED live here, not in sys/socket.h
#include <libproc.h>
#include <sys/proc.h>       // SIDL/SRUN/SSLEEP/SSTOP/SZOMB
#include <sys/proc_info.h>
#define CCS_INQ_IOCTL FIONREAD
#define CCS_PEERCRED_LEVEL SOL_LOCAL
#define CCS_PEERCRED_OPT LOCAL_PEERCRED
#else
#define CCS_INQ_IOCTL TIOCINQ
#define CCS_PEERCRED_LEVEL SOL_SOCKET
#define CCS_PEERCRED_OPT SO_PEERCRED
#endif

static const char *errno_name(int e) {
  switch (e) {
    case EBADF: return "EBADF";
    case ENOTTY: return "ENOTTY";
    case EINVAL: return "EINVAL";
    case ENOENT: return "ENOENT";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case EIO: return "EIO";
    case EAGAIN: return "EAGAIN";
    case EINTR: return "EINTR";
    case ENOTSOCK: return "ENOTSOCK";
    case ENOTCONN: return "ENOTCONN";
    case ENXIO: return "ENXIO";
    case EMFILE: return "EMFILE";
    case ENOLCK: return "ENOLCK";
    case ENOPROTOOPT: return "ENOPROTOOPT";
    default: return "EUNKNOWN";
  }
}

static napi_value throw_errno(napi_env env, const char *syscall, int e) {
  char msg[256];
  snprintf(msg, sizeof msg, "%s: %s", syscall, strerror(e));
  napi_value code, message, err, num;
  napi_create_string_utf8(env, errno_name(e), NAPI_AUTO_LENGTH, &code);
  napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, code, message, &err);
  napi_create_int32(env, e, &num);
  napi_set_named_property(env, err, "errno", num);
  napi_create_string_utf8(env, syscall, NAPI_AUTO_LENGTH, &message);
  napi_set_named_property(env, err, "syscall", message);
  napi_throw(env, err);
  return NULL;
}

static bool get_args(napi_env env, napi_callback_info info, size_t want, napi_value *argv) {
  size_t argc = want;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) return false;
  if (argc < want) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_COUNT", "missing arguments");
    return false;
  }
  return true;
}

static bool get_fd(napi_env env, napi_value v, int *out) {
  napi_valuetype t;
  napi_typeof(env, v, &t);
  if (t != napi_number) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "fd must be a number");
    return false;
  }
  int32_t fd;
  napi_get_value_int32(env, v, &fd);
  if (fd < 0) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "fd must be >= 0");
    return false;
  }
  *out = fd;
  return true;
}

static bool get_bool(napi_env env, napi_value v, bool *out) {
  napi_valuetype t;
  napi_typeof(env, v, &t);
  if (t != napi_boolean) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "expected a boolean");
    return false;
  }
  napi_get_value_bool(env, v, out);
  return true;
}

static napi_value make_bool(napi_env env, bool b) {
  napi_value v;
  napi_get_boolean(env, b, &v);
  return v;
}

static napi_value make_int(napi_env env, int64_t n) {
  napi_value v;
  napi_create_int64(env, n, &v);
  return v;
}

static napi_value Lflag(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int fd;
  if (!get_args(env, info, 1, argv) || !get_fd(env, argv[0], &fd)) return NULL;
  struct termios t;
  if (tcgetattr(fd, &t) != 0) return throw_errno(env, "tcgetattr", errno);
  napi_value obj;
  napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "icanon", make_bool(env, (t.c_lflag & ICANON) != 0));
  napi_set_named_property(env, obj, "isig", make_bool(env, (t.c_lflag & ISIG) != 0));
  napi_set_named_property(env, obj, "echo", make_bool(env, (t.c_lflag & ECHO) != 0));
  return obj;
}

static napi_value OpenSlave(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!get_args(env, info, 1, argv)) return NULL;
  napi_valuetype t;
  napi_typeof(env, argv[0], &t);
  if (t != napi_string) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "ptsPath must be a string");
    return NULL;
  }
  char path[256];
  size_t len;
  napi_get_value_string_utf8(env, argv[0], path, sizeof path, &len);
  // Linux slave ptys are /dev/pts/<n>; macOS/BSD ones are /dev/ttys<nnn>. Accept either, and
  // nothing else: the point of the guard is to refuse a non-pty path, not to spell one OS's layout.
  bool isPts = strncmp(path, "/dev/pts/", 9) == 0 && path[9] != '\0';
  bool isTtys = strncmp(path, "/dev/ttys", 9) == 0 && path[9] != '\0';
  if (len == 0 || len >= sizeof path - 1 || (!isPts && !isTtys)) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "ptsPath must look like /dev/pts/<n> or /dev/ttys<n>");
    return NULL;
  }
  int fd;
  do {
    fd = open(path, O_RDWR | O_NOCTTY | O_CLOEXEC);
  } while (fd < 0 && errno == EINTR);
  if (fd < 0) return throw_errno(env, "open", errno);
  return make_int(env, fd);
}

static napi_value CloseFd(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int fd;
  if (!get_args(env, info, 1, argv) || !get_fd(env, argv[0], &fd)) return NULL;
  // Never retry close() on EINTR (Linux releases the fd regardless).
  if (close(fd) != 0 && errno != EINTR) return throw_errno(env, "close", errno);
  return NULL;
}

static napi_value Inq(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int fd;
  if (!get_args(env, info, 1, argv) || !get_fd(env, argv[0], &fd)) return NULL;
  int n = 0;
  if (ioctl(fd, CCS_INQ_IOCTL, &n) != 0) return throw_errno(env, "ioctl(CCS_INQ_IOCTL)", errno);
  return make_int(env, n);
}

static napi_value Tcgetpgrp(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int fd;
  if (!get_args(env, info, 1, argv) || !get_fd(env, argv[0], &fd)) return NULL;
  pid_t pg = tcgetpgrp(fd);
  if (pg < 0) return throw_errno(env, "tcgetpgrp", errno);
  return make_int(env, pg);
}

static napi_value Flock(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  int fd;
  bool exclusive, nonblocking;
  if (!get_args(env, info, 3, argv) || !get_fd(env, argv[0], &fd) ||
      !get_bool(env, argv[1], &exclusive) || !get_bool(env, argv[2], &nonblocking)) return NULL;
  int op = (exclusive ? LOCK_EX : LOCK_SH) | (nonblocking ? LOCK_NB : 0);
  int rc;
  do {
    rc = flock(fd, op);
  } while (rc != 0 && errno == EINTR);
  if (rc == 0) return make_bool(env, true);
  if (nonblocking && errno == EWOULDBLOCK) return make_bool(env, false);
  return throw_errno(env, "flock", errno);
}

static napi_value PeerUid(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int fd;
  if (!get_args(env, info, 1, argv) || !get_fd(env, argv[0], &fd)) return NULL;
#if defined(__APPLE__)
  struct xucred cred;
#else
  struct ucred cred;
#endif
  socklen_t len = sizeof cred;
  if (getsockopt(fd, CCS_PEERCRED_LEVEL, CCS_PEERCRED_OPT, &cred, &len) != 0) return throw_errno(env, "getsockopt(CCS_PEERCRED_OPT)", errno);
  return make_int(env, cred.cr_uid);
}

#if defined(__APPLE__)

/** Is `pid` in the current pid list? Used only to tell a zombie from a departed process. */
static bool pid_is_listed(int32_t pid) {
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (bytes <= 0) return false;
  int capacity = bytes / (int)sizeof(int) + 64;
  int *buf = (int *)malloc((size_t)capacity * sizeof(int));
  if (buf == NULL) return false;
  int got = proc_listpids(PROC_ALL_PIDS, 0, buf, capacity * (int)sizeof(int));
  bool found = false;
  if (got > 0) {
    int count = got / (int)sizeof(int);
    for (int i = 0; i < count; i++) {
      if (buf[i] == pid) { found = true; break; }
    }
  }
  free(buf);
  return found;
}

/**
 * procInfo(pid) -> {startSec, startUsec, pgid, ppid, sid, status, zombie} | null
 *
 * `null` means the pid is not present at all (not even a zombie). `zombie: true` means the pid is
 * present but defunct.
 *
 * The zombie case is a macOS quirk worth stating: `proc_pidinfo` returns 0 bytes with ESRCH for a
 * zombie -- the BSD layer considers the credential/argv it would report already gone -- even though
 * the pid is still in `proc_listpids`. `ps` shows such a process as state Z. Linux instead reports
 * 'Z' in /proc/<pid>/stat. Without the `zombie` flag a caller cannot tell "exited and reaped" from
 * "exited, waiting to be collected", which is exactly the distinction ccs uses.
 *
 * `status` remains the raw pbi_status for non-zombies; darwin.js maps it to alive/zombie/gone so
 * the mapping lives in JS next to linux.js's equivalent.
 */
static napi_value ProcInfo(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!get_args(env, info, 1, argv)) return NULL;
  napi_valuetype t;
  napi_typeof(env, argv[0], &t);
  if (t != napi_number) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "pid must be a number");
    return NULL;
  }
  int32_t pid;
  napi_get_value_int32(env, argv[0], &pid);
  if (pid <= 0) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "pid must be > 0");
    return NULL;
  }
  struct proc_bsdinfo bi;
  int n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, PROC_PIDTBSDINFO_SIZE);
  if (n != PROC_PIDTBSDINFO_SIZE) {
    napi_value out;
    if (errno == ESRCH && pid_is_listed(pid)) {
      // Present but defunct: report it as a zombie rather than as gone.
      napi_create_object(env, &out);
      napi_value v;
      napi_get_null(env, &v);
      napi_set_named_property(env, out, "startSec", v);
      napi_set_named_property(env, out, "startUsec", v);
      napi_set_named_property(env, out, "pgid", v);
      napi_set_named_property(env, out, "ppid", v);
      napi_set_named_property(env, out, "sid", v);
      napi_create_int32(env, SZOMB, &v);
      napi_set_named_property(env, out, "status", v);
      napi_get_boolean(env, true, &v);
      napi_set_named_property(env, out, "zombie", v);
      return out;
    }
    napi_value null_v;
    napi_get_null(env, &null_v);
    return null_v;
  }
  napi_value obj;
  napi_create_object(env, &obj);
  napi_value v;
  napi_create_double(env, (double)bi.pbi_start_tvsec, &v);
  napi_set_named_property(env, obj, "startSec", v);
  napi_create_double(env, (double)bi.pbi_start_tvusec, &v);
  napi_set_named_property(env, obj, "startUsec", v);
  napi_create_int32(env, (int32_t)bi.pbi_pgid, &v);
  napi_set_named_property(env, obj, "pgid", v);
  napi_create_int32(env, (int32_t)bi.pbi_ppid, &v);
  napi_set_named_property(env, obj, "ppid", v);
  napi_create_int32(env, (int32_t)getsid(pid), &v);
  napi_set_named_property(env, obj, "sid", v);
  napi_create_int32(env, (int32_t)bi.pbi_status, &v);
  napi_set_named_property(env, obj, "status", v);
  napi_get_boolean(env, false, &v);
  napi_set_named_property(env, obj, "zombie", v);
  return obj;
}

/** listPids() -> number[] : the darwin counterpart of reading /proc and keeping the numeric names. */
static napi_value ListPids(napi_env env, napi_callback_info info) {
  (void)info;
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (bytes <= 0) {
    napi_value empty;
    napi_create_array_with_length(env, 0, &empty);
    return empty;
  }
  // Ask for a few slots more than we were told: processes can appear between the two calls,
  // and proc_listpids would rather truncate than overrun.
  int capacity = bytes / (int)sizeof(int) + 64;
  int *buf = (int *)malloc((size_t)capacity * sizeof(int));
  if (buf == NULL) {
    napi_throw_error(env, "ENOMEM", "listPids: allocation failed");
    return NULL;
  }
  int got = proc_listpids(PROC_ALL_PIDS, 0, buf, capacity * (int)sizeof(int));
  if (got <= 0) {
    free(buf);
    napi_value empty;
    napi_create_array_with_length(env, 0, &empty);
    return empty;
  }
  napi_value arr;
  napi_create_array(env, &arr);
  uint32_t out = 0;
  int count = got / (int)sizeof(int);
  for (int i = 0; i < count; i++) {
    if (buf[i] <= 0) continue; // the kernel pads the tail with zeroes
    napi_value v;
    napi_create_int32(env, buf[i], &v);
    napi_set_element(env, arr, out++, v);
  }
  free(buf);
  return arr;
}

#endif // __APPLE__

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"lflag", NULL, Lflag, NULL, NULL, NULL, napi_enumerable, NULL},
    {"openSlave", NULL, OpenSlave, NULL, NULL, NULL, napi_enumerable, NULL},
    {"closeFd", NULL, CloseFd, NULL, NULL, NULL, napi_enumerable, NULL},
    {"inq", NULL, Inq, NULL, NULL, NULL, napi_enumerable, NULL},
    {"tcgetpgrp", NULL, Tcgetpgrp, NULL, NULL, NULL, napi_enumerable, NULL},
    {"flock", NULL, Flock, NULL, NULL, NULL, napi_enumerable, NULL},
    {"peerUid", NULL, PeerUid, NULL, NULL, NULL, napi_enumerable, NULL},
#if defined(__APPLE__)
    {"procInfo", NULL, ProcInfo, NULL, NULL, NULL, napi_enumerable, NULL},
    {"listPids", NULL, ListPids, NULL, NULL, NULL, napi_enumerable, NULL},
#endif
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
