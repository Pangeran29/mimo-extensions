"""Read the HPOP key without echo and pass it only in child-process memory.
Run with the bundled Python; never put keys in command arguments or files.
"""
import getpass
import os
import subprocess
import sys
key = getpass.getpass('HPOP development key (not echoed): ')
node = os.environ.get('LISTEN_NODE', 'node')
mode = sys.argv[1] if len(sys.argv) > 1 else 'probe'
script = {'probe':'assistant-probe.mjs','native-probe':'assistant-native-probe.mjs','benchmark':'assistant-benchmark.mjs','smoke':'transcription-smoke.mjs','soak':'transcription-smoke.mjs'}[mode]
env = {**os.environ, 'LISTEN_HPOP_KEY':key}
if mode in ('smoke','soak'):
    env['LISTEN_ASSISTANT']='1'
if mode == 'soak':
    env['LISTEN_SOAK_SECONDS']='1200'
sys.exit(subprocess.run([node, 'scripts/'+script], env=env).returncode)
