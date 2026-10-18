def add_headers(resp):
    resp.headers["Content-Security-Policy"] = "default-src 'self'"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000"
    resp.headers["X-Frame-Options"] = "SAMEORIGIN"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    return resp
