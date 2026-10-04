"""Loopback-only static server, with logs independent of the launcher console."""
import argparse
import contextlib
import functools
import http.server
from pathlib import Path
import traceback


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    root = args.directory.resolve(strict=True)
    runtime = root / ".runtime"
    runtime.mkdir(exist_ok=True)
    with (runtime / f"server-{args.port}.stdout.log").open("a", encoding="utf-8", buffering=1) as out:
        with (runtime / f"server-{args.port}.stderr.log").open("a", encoding="utf-8", buffering=1) as err:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
                    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
                        print(f"Robot arm server: http://127.0.0.1:{args.port}/")
                        server.serve_forever()
                except Exception:
                    traceback.print_exc()
                    return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
