// Lets a macOS serial library open a pseudo-terminal.
//
// The `serialport` crate sets baud with the IOSSIOSPEED ioctl and drives
// DTR/RTS with the modem-control ioctls. A pty is a tty but supports none of
// them, so the open fails with ENOTTY ("Not a typewriter"). This shim lets
// those calls succeed on a character device; every other ioctl passes
// through untouched.
//
// Build: clang -dynamiclib -o pty_shim.dylib pty_shim.c
// Use:   DYLD_INSERT_LIBRARIES=/path/to/pty_shim.dylib target/debug/bearpaw ...

#include <errno.h>
#include <stdarg.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>

#define IOSSIOSPEED 0x80045402UL  // <IOKit/serial/ioss.h>

static int is_serial_request(unsigned long request) {
    switch (request) {
    case IOSSIOSPEED: case TIOCMGET: case TIOCMSET: case TIOCMBIS: case TIOCMBIC:
    case TIOCSDTR: case TIOCCDTR:
        return 1;
    default:
        return 0;
    }
}

static int shim_ioctl(int fd, unsigned long request, ...) {
    va_list ap;
    va_start(ap, request);
    void *arg = va_arg(ap, void *);
    va_end(ap);

    int result = ioctl(fd, request, arg);
    // Not isatty(): it calls ioctl itself, which re-enters this shim forever.
    struct stat st;
    if (result == -1 && errno == ENOTTY && is_serial_request(request) &&
        fstat(fd, &st) == 0 && S_ISCHR(st.st_mode)) {
        if (request == TIOCMGET && arg) {
            *(int *)arg = TIOCM_DTR | TIOCM_RTS | TIOCM_CTS | TIOCM_DSR;
        }
        return 0;
    }
    return result;
}

__attribute__((used, section("__DATA,__interpose")))
static struct { void *replacement; void *original; } interpose_ioctl = {
    (void *)shim_ioctl, (void *)ioctl
};
