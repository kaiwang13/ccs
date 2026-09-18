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
#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <termios.h>
#include <unistd.h>

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
  if (len == 0 || len >= sizeof path - 1 || strncmp(path, "/dev/pts/", 9) != 0) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "ptsPath must look like /dev/pts/<n>");
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
  if (ioctl(fd, TIOCINQ, &n) != 0) return throw_errno(env, "ioctl(TIOCINQ)", errno);
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
  struct ucred cred;
  socklen_t len = sizeof cred;
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) return throw_errno(env, "getsockopt(SO_PEERCRED)", errno);
  return make_int(env, cred.uid);
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"lflag", NULL, Lflag, NULL, NULL, NULL, napi_enumerable, NULL},
    {"openSlave", NULL, OpenSlave, NULL, NULL, NULL, napi_enumerable, NULL},
    {"closeFd", NULL, CloseFd, NULL, NULL, NULL, napi_enumerable, NULL},
    {"inq", NULL, Inq, NULL, NULL, NULL, napi_enumerable, NULL},
    {"tcgetpgrp", NULL, Tcgetpgrp, NULL, NULL, NULL, napi_enumerable, NULL},
    {"flock", NULL, Flock, NULL, NULL, NULL, napi_enumerable, NULL},
    {"peerUid", NULL, PeerUid, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
