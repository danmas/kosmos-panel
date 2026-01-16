const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

// Создаём папку logs если не существует
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getLogFilePath(category = 'app') {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(LOGS_DIR, `${category}-${date}.log`);
}

function formatMessage(level, category, message, meta = null) {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] [${category}] ${message}${metaStr}\n`;
}

function writeToFile(category, content) {
  try {
    fs.appendFileSync(getLogFilePath(category), content);
  } catch (err) {
    console.error('[Logger] Failed to write to file:', err.message);
  }
}

const logger = {
  info(category, message, meta = null) {
    const formatted = formatMessage('INFO', category, message, meta);
    process.stdout.write(formatted);
    writeToFile(category, formatted);
  },

  warn(category, message, meta = null) {
    const formatted = formatMessage('WARN', category, message, meta);
    process.stdout.write(formatted);
    writeToFile(category, formatted);
  },

  error(category, message, meta = null) {
    const formatted = formatMessage('ERROR', category, message, meta);
    process.stderr.write(formatted);
    writeToFile(category, formatted);
  },

  debug(category, message, meta = null) {
    if (process.env.DEBUG) {
      const formatted = formatMessage('DEBUG', category, message, meta);
      process.stdout.write(formatted);
      writeToFile(category, formatted);
    }
  }
};

module.exports = logger;
