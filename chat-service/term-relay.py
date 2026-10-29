"""
A terminal for a browser: run one command on a pseudo-terminal and relay it.

The mux's terminal panes are the real Claude Code CLI in a tmux session, exactly
what `cc` gives you in an editor terminal. tmux wants a terminal to attach to, and
Node has no pseudo-terminal without a native module — one that has to be rebuilt for
every Node upgrade and that this box's deploy would have to compile. Python has one
in its standard library, so this is the whole of the native part: `pty.fork`, a
`select` loop, and one `ioctl` for the window size.

    python3 -I term-relay.py <cols> <rows> <command> [args...]

stdout is the terminal's output, byte for byte. stdin is framed, because it carries
two things — keystrokes and window sizes — and a keystroke can be any byte:

    kind (1 byte) | length (4 bytes, big-endian) | payload
    'd' — bytes to type into the terminal
    'r' — a new size: columns and rows, two big-endian uint16s

Setting the size on the pty is what tells tmux: the kernel sends the foreground
process SIGWINCH, and tmux redraws the window for the new size.

When stdin closes — the browser went away, the chat service restarted — the command
is sent SIGHUP. For `tmux attach` that is a detach, and the session, and the Claude
in it, carry on in the tmux server. The exit status is the command's own.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, cols, rows):
    cols = max(2, min(int(cols), 1000))
    rows = max(2, min(int(rows), 1000))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def main():
    if len(sys.argv) < 4:
        sys.stderr.write('usage: term-relay.py <cols> <rows> <command> [args...]\n')
        return 2
    cols, rows, argv = sys.argv[1], sys.argv[2], sys.argv[3:]

    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        finally:
            os._exit(127)

    set_size(fd, cols, rows)
    stdin = sys.stdin.fileno()
    stdout = sys.stdout.fileno()
    pending = b''
    stdin_open = True

    while True:
        watch = [fd] + ([stdin] if stdin_open else [])
        try:
            # Once the browser is gone the command has had its SIGHUP; a few seconds
            # to act on it, and then it is not waited for any longer.
            readable, _, _ = select.select(watch, [], [], None if stdin_open else 5)
        except InterruptedError:
            continue
        if not stdin_open and not readable:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            break

        if fd in readable:
            try:
                data = os.read(fd, 65536)
            except OSError as err:
                # EIO is how Linux reports that the other end of the pty has closed:
                # the command has exited.
                if err.errno != errno.EIO:
                    raise
                data = b''
            if not data:
                break
            os.write(stdout, data)

        if stdin_open and stdin in readable:
            chunk = os.read(stdin, 65536)
            if not chunk:
                stdin_open = False
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
                continue
            pending += chunk
            while len(pending) >= 5:
                kind = pending[0:1]
                (length,) = struct.unpack('>I', pending[1:5])
                if len(pending) < 5 + length:
                    break
                payload = pending[5:5 + length]
                pending = pending[5 + length:]
                if kind == b'd':
                    view = memoryview(payload)
                    while view:
                        written = os.write(fd, view)
                        view = view[written:]
                elif kind == b'r' and length == 4:
                    set_size(fd, *struct.unpack('>HH', payload))

    _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 128 + os.WTERMSIG(status)


if __name__ == '__main__':
    sys.exit(main())
