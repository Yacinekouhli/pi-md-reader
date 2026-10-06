"""PTY + pyte harness: run pi in a real terminal, drive it with keystrokes, read the screen."""
import os, pty, select, signal, sys, time, fcntl, termios, struct
import pyte


class PiSession:
    def __init__(self, args, cols=120, rows=40, env=None, cwd=None):
        self.cols, self.rows = cols, rows
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = bytearray()
        environ = dict(os.environ)
        environ.update({
            "TERM": "xterm-256color",
            "PI_OFFLINE": "1",
            "COLUMNS": str(cols),
            "LINES": str(rows),
            "NO_COLOR": "",
        })
        environ.pop("PI_TUI_WRITE_LOG", None)
        if env:
            environ.update(env)
        pid, fd = pty.fork()
        if pid == 0:
            if cwd:
                os.chdir(cwd)
            os.execvpe(args[0], args, environ)
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(self, timeout=0.35):
        end = time.time() + timeout
        got = False
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if not r:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                break
            if not data:
                break
            self.raw.extend(data)
            self.stream.feed(data)
            got = True
        return got

    def wait_for(self, predicate, timeout=20.0, description="condition"):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.25)
            if predicate(self):
                return True
        raise TimeoutError(f"timed out waiting for {description}\n--- screen ---\n{self.text()}")

    def send(self, data):
        os.write(self.fd, data.encode() if isinstance(data, str) else data)

    def type_text(self, text, settle=0.12):
        for ch in text:
            self.send(ch)
            self.pump(0.01)
        self.pump(settle)

    def lines(self):
        return [l.rstrip() for l in self.screen.display]

    def text(self):
        return "\n".join(self.lines())

    def contains(self, needle):
        return needle in self.text()

    def close(self, timeout=6.0):
        try:
            self.send("\x03")
            self.pump(0.2)
            self.send("\x03")
        except OSError:
            pass
        end = time.time() + timeout
        while time.time() < end:
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                return
            if pid:
                return
            self.pump(0.2)
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
