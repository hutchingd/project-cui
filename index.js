const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'server', 'index.js');
const MAX_DELAY = 30000;
const BASE_DELAY = 1000;

let delay = BASE_DELAY;
let child = null;
let stopping = false;

function start() {
  if (stopping) return;

  child = spawn('node', [SCRIPT], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;

    console.error(`[runner] exited code=${code} signal=${signal} restarting in ${delay}ms`);
    setTimeout(() => {
      delay = Math.min(delay * 2, MAX_DELAY);
      start();
    }, delay);
  });

  child.on('error', (err) => {
    console.error('[runner] spawn error:', err);
  });

  child.on('spawn', () => {
    console.log('[runner] started');
    delay = BASE_DELAY;
  });
}

function shutdown(signal) {
  stopping = true;
  if (child) {
    child.kill(signal);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
