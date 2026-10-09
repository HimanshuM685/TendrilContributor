#!/usr/local/bin/python3
"""Guest init/supervisor. Secrets are never printed or passed as argv."""
import json
import os
import resource
import select
import signal
import socket
import ssl
import subprocess
import threading
import secrets
import time
from tls_bridge import start_bridge

with open('/etc/tendril/lease.json') as f:
    cfg = json.load(f)
subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
subprocess.run(['ip', 'addr', 'add', cfg['ip'] + '/30', 'dev', 'eth0'], check=True)
subprocess.run(['ip', 'link', 'set', 'eth0', 'up'], check=True)
subprocess.run(['ip', 'route', 'add', 'default', 'via', cfg['gateway']], check=True)
with open('/etc/resolv.conf', 'w') as f:
    f.write('nameserver ' + cfg['dns'] + '\n')
os.makedirs('/root/.ssh', mode=0o700, exist_ok=True)
with open('/root/.ssh/authorized_keys', 'w') as f:
    f.write('\n'.join(cfg['keys']) + '\n')
os.chmod('/root/.ssh/authorized_keys', 0o600)
password = cfg.get('password')
if password:
    subprocess.run(['chpasswd'], input='root:' + password + '\n', text=True, check=True)
else:
    # An unlocked, unguessable password hash avoids sshd's locked-account check.
    subprocess.run(['chpasswd'], input='root:' + secrets.token_urlsafe(64) + '\n', text=True, check=True)
with open('/etc/ssh/sshd_config', 'w') as f:
    f.write('PermitRootLogin yes\nPubkeyAuthentication yes\nUsePAM yes\n'
            'PasswordAuthentication ' + ('yes' if password else 'no') + '\n'
            'KbdInteractiveAuthentication no\nHostKey /etc/ssh/ssh_host_ed25519_key\n')
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
resource.setrlimit(resource.RLIMIT_NPROC, (256, 256))
children = []
stopping = threading.Event()

def start(args, env=None):
    # Jupyter logs can include token URLs; discard output instead of forwarding serial.
    children.append(subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True))

start(['/usr/sbin/sshd', '-D', '-e'])
if cfg.get('notebook'):
    jupyter_cfg = {'ServerApp': {'ip': '0.0.0.0', 'port': 8888, 'root_dir': '/work', 'base_url': '/',
                                'open_browser': False, 'allow_root': True, 'allow_remote_access': True,
                                'trust_xheaders': True, 'log_level': 'CRITICAL'},
                   'IdentityProvider': {'token': cfg['token']}}
    with open('/etc/tendril/jupyter.json', 'w') as f:
        json.dump(jupyter_cfg, f)
    os.chmod('/etc/tendril/jupyter.json', 0o600)
    start(['jupyter', 'lab', '--config=/etc/tendril/jupyter.json'])
for kind, local_host, local_port in [('ssh', '127.0.0.1', 22), ('notebook', '127.0.0.2', 8888)]:
    tunnel = cfg.get('relay', {}).get(kind)
    if not tunnel:
        continue
    start_bridge(local_host, tunnel, stopping)
    env = dict(os.environ, BORE_SECRET=tunnel['secret'])
    start(['bore', 'local', str(local_port), '--local-host', '127.0.0.1', '--to', local_host, '--port', str(tunnel['remotePort'])], env)

def stop(*_):
    stopping.set()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while not stopping.wait(.25):
    if any(p.poll() is not None for p in children):
        stopping.set()
for p in children:
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
for p in children:
    try:
        p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
os.sync()
subprocess.run(['reboot', '-f'])
