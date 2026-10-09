"""Verified TLS transport for every bore control/data connection."""
import socket
import ssl
import threading

def connection(raw, tunnel, stopping):
    remote = None
    try:
        ctx = ssl.create_default_context()
        remote = ctx.wrap_socket(socket.create_connection((tunnel['controlHost'], tunnel['controlPort']), timeout=10),
                                 server_hostname=tunnel['controlHost'])
        remote.settimeout(None)
        def copy(src, dst):
            try:
                while not stopping.is_set():
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            finally:
                try:
                    dst.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        thread = threading.Thread(target=copy, args=(raw, remote), daemon=True)
        thread.start()
        copy(remote, raw)
        thread.join(timeout=1)
    except (OSError, ssl.SSLError):
        pass
    finally:
        raw.close()
        if remote:
            remote.close()

def start_bridge(host, tunnel, stopping):
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((host, 7835))
    listener.listen(64)
    listener.settimeout(1)
    def accept():
        while not stopping.is_set():
            try:
                raw, _ = listener.accept()
                threading.Thread(target=connection, args=(raw, tunnel, stopping), daemon=True).start()
            except socket.timeout:
                pass
        listener.close()
    threading.Thread(target=accept, daemon=True).start()
