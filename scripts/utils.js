const { spawn } = require('child_process');

class ChildProcessError extends Error {
  constructor(message, code, signal) {
    super(message);
    this.name = 'ChildProcessError';
    this.code = code;
    this.signal = signal;
  }
}

async function waitOnChild(child) {
  return new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new ChildProcessError('Process failed', code, signal));
      }
    });
    child.on('error', reject);
  });
}

async function kill(child, signal = 'SIGINT') {
  if (process.platform === 'win32') {
    // -PID not supported on Windows
    process.kill(child.pid, signal);
  } else {
    process.kill(-child.pid, signal);
  }
  try {
    await waitOnChild(child);
  } catch (err) {
    // Should error if the error is not a child process error or it is a child
    // process and either the platform is Windows or the signal matches.
    const shouldError = err.name !== 'ChildProcessError' || (process.platform !== 'win32' && err.signal !== signal);
    if (shouldError) {
      throw err;
    }
  }
}

async function spawnNpx(args, opts) {
  let fullCommand = ['npx', '--prefer-offline', '--timing=true', '--yes', '--', ...args];

  // NPM is a .cmd on Windows
  if (process.platform == 'win32') {
    fullCommand = ['cmd', '/C', ...fullCommand];
  }

  await waitOnChild(spawn(fullCommand[0], fullCommand.slice(1), opts));
}

const shell = process.platform === 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { kill, spawnNpx, ChildProcessError, shell, sleep };
