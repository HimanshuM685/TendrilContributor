#!/usr/local/bin/python3
"""Execute inside guest with a deadline, process-group cancellation and output cap."""
import json
import os
import pathlib
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time

request = json.load(sys.stdin)
timeout = min(3600, max(1, float(request.get('timeout', 120))))
job = request.get('jobId')
if job:
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', job):
        raise ValueError('invalid job id')
    cwd = pathlib.Path('/work/jobs') / job
    args = ['papermill', str(cwd / 'in.ipynb'), str(cwd / 'out.ipynb'), '--cwd', str(cwd)]
else:
    cwd = pathlib.Path('/work')
    script = tempfile.NamedTemporaryFile(mode='w', suffix='.py', dir=cwd, delete=False)
    script.write(request['payload'])
    script.close()
    args = ['python3', script.name]
p = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
deadline = time.monotonic() + timeout
sel = selectors.DefaultSelector()
sel.register(p.stdout, selectors.EVENT_READ, 'out')
sel.register(p.stderr, selectors.EVENT_READ, 'err')
out, err, total, failure = [], [], 0, None
while sel.get_map():
    if time.monotonic() > deadline:
        failure = 'job timed out'
        break
    for key, _ in sel.select(timeout=.1):
        data = os.read(key.fd, 65536)
        if not data:
            sel.unregister(key.fileobj)
            continue
        total += len(data)
        if total > 4_000_000:
            failure = 'job output limit exceeded'
            break
        (out if key.data == 'out' else err).append(data)
    if failure:
        break
# Wait for the parent normally, then kill any remaining descendants.
try:
    code = p.wait(timeout=max(.01, deadline - time.monotonic()) if not failure else .01)
except subprocess.TimeoutExpired:
    failure = failure or 'job timed out'
    code = -1
# Kill descendants even if their parent exited or closed its output descriptors.
try:
    os.killpg(p.pid, signal.SIGKILL)
except ProcessLookupError:
    pass
p.wait()
sel.close()
if not job:
    os.unlink(script.name)
stdout, stderr = b''.join(out).decode(errors='replace'), b''.join(err).decode(errors='replace')
print(json.dumps({'ok': code == 0 and not failure, 'output': stdout if code == 0 and not failure else '\n'.join([stdout, stderr, failure or '']).strip()}))
