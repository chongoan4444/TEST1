#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve_reports.py — Mở báo cáo HTML bằng 1 web server nhỏ (tiện xem trên trình duyệt
hoặc qua preview của Arena).

    python3 tools/serve_reports.py                      # mặc định: reports/demo_leads.html
    python3 tools/serve_reports.py reports/har_thuc_te_leads.html --port 8080
"""

import argparse
import http.server
import os
import socketserver


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("index", nargs="?", default="reports/demo_leads.html",
                    help="file HTML muốn mở ở trang chủ (mặc định: reports/demo_leads.html)")
    ap.add_argument("--root", default=".", help="thư mục gốc để serve (mặc định: .)")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    index = "/" + os.path.relpath(os.path.abspath(args.index), root).replace(os.sep, "/")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                self.send_response(302)
                self.send_header("Location", index)
                self.end_headers()
                return
            super().do_GET()

        def log_message(self, fmt, *a):
            print("%s - %s" % (self.address_string(), fmt % a), flush=True)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", args.port), Handler) as httpd:
        print(f"Serving {root} → http://0.0.0.0:{args.port} (trang chủ: {index})", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
