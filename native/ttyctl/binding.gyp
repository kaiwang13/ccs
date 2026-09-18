{
  "targets": [
    {
      "target_name": "ttyctl",
      "sources": ["ttyctl.c"],
      "defines": ["NAPI_VERSION=8", "_GNU_SOURCE"],
      "cflags": ["-Wall", "-Wextra", "-Werror", "-O2", "-std=gnu11"]
    }
  ]
}
