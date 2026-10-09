#!/usr/local/bin/python3
"""Legacy container SSH uses the same per-lease TLS/bore allocation."""
import json
import os
import signal
import subprocess
import threading
from tls_bridge import start_bridge

tunnel = json.loads(os.environ['TENDRIL_RELAY_JSON'])['ssh']
stopping = threading.Event()
start_bridge('127.0.0.1', tunnel, stopping)
child = subprocess.Popen(['bore', 'local', '22', '--to', '127.0.0.1', '--port', str(tunnel['remotePort'])],
                         env=dict(os.environ, BORE_SECRET=tunnel['secret']), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
def stop(*_):
    stopping.set()
    child.terminate()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
for line in child.stdout:
    if 'listening at ' in line:
        print('listening at ' + tunnel['publicHost'] + ':' + str(tunnel['publicPort']), flush=True)
stopping.set()
raise SystemExit(child.wait())
