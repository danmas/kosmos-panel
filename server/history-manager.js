const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

const HISTORY_FILE = path.join(__dirname, '..', 'tmp', 'term_command_history.json');
const MAX_ENTRIES = 500;

class HistoryManager {
  constructor() {
    this._queue = Promise.resolve();
  }

  /**
   * Чтение файла истории, возвращает массив строк
   */
  async loadHistory() {
    try {
      const data = await fs.readFile(HISTORY_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error('history', 'Error reading history file', { error: err.message });
      }
      return [];
    }
  }

  /**
   * Сохранение команды: read-merge-write с очередью для предотвращения race conditions
   */
  saveCommand(cmd) {
    if (!cmd || typeof cmd !== 'string' || !cmd.trim()) return;
    const trimmed = cmd.trim();

    this._queue = this._queue.then(async () => {
      try {
        const history = await this.loadHistory();

        // Удалить дубликат если есть
        const idx = history.indexOf(trimmed);
        if (idx !== -1) {
          history.splice(idx, 1);
        }

        // Добавить в начало
        history.unshift(trimmed);

        // Обрезать до MAX_ENTRIES
        if (history.length > MAX_ENTRIES) {
          history.length = MAX_ENTRIES;
        }

        // Записать файл
        await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
        await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
        logger.info('history', 'History file saved', { entries: history.length, file: HISTORY_FILE });
      } catch (err) {
        logger.error('history', 'Error saving command to history', { error: err.message });
      }
    }).catch(err => {
      logger.error('history', 'Error in history queue', { error: err.message });
    });
  }

  /**
   * Фильтрация: вернуть команды содержащие prefix (case-insensitive substring match)
   * Если prefix пустой — вернуть всё. Порядок: новые первые (как в файле)
   */
  async getMatches(prefix) {
    const history = await this.loadHistory();
    if (!prefix || !prefix.trim()) return history;
    const lowerPrefix = prefix.toLowerCase();
    return history.filter(cmd => cmd.toLowerCase().includes(lowerPrefix));
  }
}

module.exports = new HistoryManager();
