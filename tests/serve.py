#!/usr/bin/env python3
"""The file server the browser tests run against: python tests/serve.py [directory]

The same as `python -m http.server 8788 --bind 127.0.0.1 -d <directory>`, except that it lets
128 connections queue instead of 5. Parallel browser tests open more than 5 at once, and the
rest were refused, so a run lost a test or two at random. Standard library only.
"""

from __future__ import annotations

import functools
import http.server
import sys


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128


if __name__ == "__main__":
    directory = sys.argv[1] if len(sys.argv) > 1 else "."
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    Server(("127.0.0.1", 8788), handler).serve_forever()
