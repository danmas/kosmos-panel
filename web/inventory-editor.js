class InventoryEditor {
  constructor() {
    this.currentData = null;
    this.isModified = false;
    this.autoSaveTimer = null;
    this.validationTimer = null;
    this.codeMirror = null;

    this.initElements();
    this.initCodeMirror();
    this.bindEvents();
    this.loadInventory();
  }

  initElements() {
    this.jsonEditor = document.getElementById('json-editor');
    this.jsonEditorContainer = document.getElementById('json-editor-container');
    this.saveBtn = document.getElementById('save-btn');
    this.reloadBtn = document.getElementById('reload-btn');
    this.validateBtn = document.getElementById('validate-btn');
    this.reformatBtn = document.getElementById('reformat-btn');
    this.addServerBtn = document.getElementById('add-server-btn');
    this.addCredentialBtn = document.getElementById('add-credential-btn');
    this.reloadConfigBtn = document.getElementById('reload-config-btn');

    this.serverList = document.getElementById('server-list');
    this.lineColStatus = document.getElementById('line-col');
    this.fileSizeStatus = document.getElementById('file-size');
    this.validationStatus = document.getElementById('validation-status');
    this.saveStatus = document.getElementById('save-status');
    this.saveDot = document.getElementById('save-dot');

    this.confirmModal = document.getElementById('confirm-modal');
    this.modalTitle = document.getElementById('modal-title');
    this.modalMessage = document.getElementById('modal-message');
    this.modalCancel = document.getElementById('modal-cancel');
    this.modalConfirm = document.getElementById('modal-confirm');

    this.tabs = document.querySelectorAll('.editor-tab');
    this.jsonTab = document.getElementById('json-tab');
    this.previewTab = document.getElementById('preview-tab');
    this.previewContent = document.getElementById('preview-content');
    this.aiConfigTab = document.getElementById('ai-config-tab');
    this.aiConfigForm = document.getElementById('ai-config-form');

  }

  initCodeMirror() {
    try {
      if (typeof CodeMirror === 'undefined') {
        console.warn('CodeMirror не загружен, используем fallback textarea');
        return;
      }

      this.codeMirror = CodeMirror(this.jsonEditorContainer, {
        mode: { name: "javascript", json: true },
        theme: "material-darker",
        lineNumbers: true,
        lineWrapping: false,
        matchBrackets: true,
        autoCloseBrackets: true,
        styleActiveLine: true,
        foldGutter: true,
        gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
        indentUnit: 2,
        tabSize: 2,
        indentWithTabs: false,
        extraKeys: {
          "Ctrl-S": () => this.saveInventory(),
          "Ctrl-Shift-F": () => this.reformatJson(),
          "Tab": (cm) => {
            if (cm.somethingSelected()) {
              cm.indentSelection("add");
            } else {
              cm.replaceSelection(Array(cm.getOption("indentUnit") + 1).join(" "));
            }
          }
        }
      });

      // События CodeMirror
      this.codeMirror.on('change', () => this.onEditorChange());
      this.codeMirror.on('cursorActivity', () => this.updateCursorPosition());

    } catch (error) {
      console.error('Ошибка инициализации CodeMirror:', error);
      console.log('Используем fallback textarea');
      this.codeMirror = null;
    }
  }

  bindEvents() {
    // Редактор (оставляем для fallback)
    this.jsonEditor.addEventListener('input', () => this.onEditorChange());
    this.jsonEditor.addEventListener('keyup', () => this.updateCursorPosition());
    this.jsonEditor.addEventListener('click', () => this.updateCursorPosition());
    this.jsonEditor.addEventListener('scroll', () => this.updateCursorPosition());

    // Кнопки
    this.saveBtn.addEventListener('click', () => this.saveInventory());
    this.reloadBtn.addEventListener('click', () => this.confirmReload());
    this.validateBtn.addEventListener('click', () => this.validateJson());
    this.reformatBtn.addEventListener('click', () => this.reformatJson());
    this.addServerBtn.addEventListener('click', () => this.addServer());
    this.addCredentialBtn.addEventListener('click', () => this.addCredential());
    this.reloadConfigBtn.addEventListener('click', () => this.reloadConfig());

    // AI Config
    this.aiConfigForm.addEventListener('submit', (e) => this.saveAiConfig(e));


    // Вкладки
    this.tabs.forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    // Модальные окна
    this.modalCancel.addEventListener('click', () => this.hideModal());
    this.modalConfirm.addEventListener('click', () => this.confirmAction());

    // Горячие клавиши
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        this.saveInventory();
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        this.reformatJson();
      }
    });

    // Предотвращение потери данных
    window.addEventListener('beforeunload', (e) => {
      if (this.isModified) {
        e.preventDefault();
        e.returnValue = 'У вас есть несохраненные изменения. Покинуть страницу?';
      }
    });
  }

  async loadInventory() {
    try {
      this.setSaveStatus('loading', 'Загрузка...');
      const response = await fetch('/inventory.json');

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      this.currentData = JSON.parse(text);
      const formattedJson = JSON.stringify(this.currentData, null, 2);

      // Обновляем CodeMirror
      this.codeMirror.setValue(formattedJson);

      // Fallback для textarea
      this.jsonEditor.value = formattedJson;

      this.isModified = false;
      this.updateFileSize();
      this.updateServerList();
      this.updatePreview();
      this.validateJson();
      this.setSaveStatus('saved', 'Загружено');

      // Обновляем позицию курсора
      setTimeout(() => this.updateCursorPosition(), 100);

    } catch (error) {
      console.error('Ошибка загрузки inventory.json:', error);
      this.setSaveStatus('error', 'Ошибка загрузки');
      const errorContent = `// Ошибка загрузки inventory.json: ${error.message}\n// Создайте новый файл или проверьте права доступа\n\n{\n  "credentials": [],\n  "servers": [],\n  "poll": {\n    "intervalSec": 15,\n    "concurrency": 6\n  }\n}`;

      this.setEditorValue(errorContent);
      this.validateJson();
    }
  }

  async saveInventory() {
    try {
      // Определяем активную вкладку
      const activeTab = document.querySelector('.editor-tab.active')?.dataset.tab;

      if (activeTab === 'ai-config') {
        return await this.saveAiConfig();
      }

      this.setSaveStatus('saving', 'Сохранение...');

      this.saveBtn.disabled = true;

      // Валидация перед сохранением
      const data = JSON.parse(this.getEditorValue());

      const response = await fetch('/api/inventory', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      this.currentData = data;
      this.isModified = false;
      this.updateServerList();
      this.updatePreview();
      this.setSaveStatus('saved', 'Сохранено');

      // Попытка перезагрузить конфигурацию на сервере
      try {
        await fetch('/api/reload', { method: 'POST' });
      } catch (reloadError) {
        console.warn('Не удалось перезагрузить конфигурацию:', reloadError);
      }

    } catch (error) {
      console.error('Ошибка сохранения:', error);
      this.setSaveStatus('error', `Ошибка: ${error.message}`);
      this.showValidationError(error.message);
    } finally {
      this.saveBtn.disabled = false;
    }
  }

  validateJson() {
    try {
      const data = JSON.parse(this.getEditorValue());

      // Базовая валидация структуры
      if (!data || typeof data !== 'object') {
        throw new Error('Корневой элемент должен быть объектом');
      }

      if (!Array.isArray(data.credentials)) {
        throw new Error('Поле "credentials" должно быть массивом');
      }

      if (!Array.isArray(data.servers)) {
        throw new Error('Поле "servers" должно быть массивом');
      }

      if (!data.poll || typeof data.poll !== 'object') {
        throw new Error('Поле "poll" должно быть объектом');
      }

      // Валидация серверов
      data.servers.forEach((server, index) => {
        if (!server.id) throw new Error(`Сервер ${index + 1}: отсутствует поле "id"`);
        if (!server.name) throw new Error(`Сервер ${index + 1}: отсутствует поле "name"`);
        if (!server.ssh) throw new Error(`Сервер ${index + 1}: отсутствует поле "ssh"`);
        if (!server.ssh.host) throw new Error(`Сервер ${index + 1}: отсутствует "ssh.host"`);
        if (!server.ssh.user) throw new Error(`Сервер ${index + 1}: отсутствует "ssh.user"`);
        if (!Array.isArray(server.services)) {
          throw new Error(`Сервер ${index + 1}: поле "services" должно быть массивом`);
        }
      });

      // Валидация учетных данных
      data.credentials.forEach((cred, index) => {
        if (!cred.id) throw new Error(`Учетные данные ${index + 1}: отсутствует поле "id"`);
        if (!cred.type) throw new Error(`Учетные данные ${index + 1}: отсутствует поле "type"`);
      });

      this.showValidationSuccess();
      return true;

    } catch (error) {
      this.showValidationError(error.message);
      return false;
    }
  }

  showValidationSuccess() {
    this.validationStatus.className = 'validation-ok';
    this.validationStatus.textContent = '✓ JSON корректен';
  }

  showValidationError(message) {
    this.validationStatus.className = 'validation-error';
    this.validationStatus.textContent = `✗ ${message}`;
  }

  reformatJson() {
    try {
      const data = JSON.parse(this.getEditorValue());
      const formatted = JSON.stringify(data, null, 2);
      this.setEditorValue(formatted);
      this.onEditorChange();
      this.setSaveStatus('modified', 'Отформатировано');
    } catch (error) {
      this.showValidationError(`Невозможно отформатировать: ${error.message}`);
    }
  }

  onEditorChange() {
    this.isModified = true;
    this.updateFileSize();

    // Отложенная валидация
    clearTimeout(this.validationTimer);
    this.validationTimer = setTimeout(() => this.validateJson(), 500);

    // Автосохранение (отключено по умолчанию)
    // this.scheduleAutoSave();

    this.setSaveStatus('modified', 'Изменено');
  }

  scheduleAutoSave() {
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      if (this.isModified && this.validateJson()) {
        this.saveInventory();
      }
    }, 3000);
  }

  updateCursorPosition() {
    if (this.codeMirror) {
      const cursor = this.codeMirror.getCursor();
      this.lineColStatus.textContent = `Строка ${cursor.line + 1}, Столбец ${cursor.ch + 1}`;
    } else {
      // Fallback для textarea
      const textarea = this.jsonEditor;
      const text = textarea.value;
      const cursorPos = textarea.selectionStart;

      const lines = text.substring(0, cursorPos).split('\n');
      const line = lines.length;
      const column = lines[lines.length - 1].length + 1;

      this.lineColStatus.textContent = `Строка ${line}, Столбец ${column}`;
    }
  }

  updateFileSize() {
    const content = this.getEditorValue();
    const bytes = new Blob([content]).size;
    const kb = (bytes / 1024).toFixed(1);
    this.fileSizeStatus.textContent = `${kb} КБ (${bytes} байт)`;
  }

  updateServerList() {
    if (!this.currentData || !this.currentData.servers) {
      this.serverList.innerHTML = '<div style="color: var(--text-muted); font-style: italic;">Нет серверов</div>';
      return;
    }

    this.serverList.innerHTML = this.currentData.servers
      .map(server => `
        <div class="server-item" onclick="editor.jumpToServer('${server.id}')">
          <div class="server-name">${server.name}</div>
          <div class="server-env">${server.env || 'unknown'}</div>
          <div class="server-services">${(server.services || []).length} сервисов</div>
        </div>
      `).join('');
  }

  jumpToServer(serverId) {
    const content = this.getEditorValue();
    const serverRegex = new RegExp(`"id"\\s*:\\s*"${serverId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
    const match = serverRegex.exec(content);

    if (match && this.codeMirror) {
      // Находим позицию в CodeMirror
      const pos = this.codeMirror.posFromIndex(match.index);
      this.codeMirror.setCursor(pos);
      this.codeMirror.scrollIntoView(pos, 100);
      this.codeMirror.focus();
      this.updateCursorPosition();
    } else if (match) {
      // Fallback для textarea
      this.jsonEditor.focus();
      this.jsonEditor.setSelectionRange(match.index, match.index);
      this.updateCursorPosition();
    }
  }

  updatePreview() {
    if (!this.currentData) {
      this.previewContent.innerHTML = '<div style="color: var(--text-muted);">Нет данных для предварительного просмотра</div>';
      return;
    }

    const serversHtml = (this.currentData.servers || []).map(server => `
      <div style="border: 1px solid var(--border); border-radius: 4px; padding: 1rem; margin-bottom: 1rem; background: var(--bg-dark);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <h3 style="margin: 0; color: var(--text);">${server.name}</h3>
          <span style="background: var(--accent); color: var(--bg-dark); padding: 0.25rem 0.5rem; border-radius: 3px; font-size: 0.8rem;">${server.env || 'unknown'}</span>
        </div>
        <div style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 0.5rem;">
          SSH: ${server.ssh.user}@${server.ssh.host}:${server.ssh.port || 22}
        </div>
        <div style="margin-top: 0.75rem;">
          <strong style="color: var(--text);">Сервисы:</strong>
          <div style="margin-top: 0.5rem;">
            ${(server.services || []).map(service => `
              <div style="display: flex; justify-content: space-between; padding: 0.25rem 0; border-bottom: 1px solid rgba(255,255,255,0.1);">
                <span style="color: var(--text);">${service.name}</span>
                <span style="color: var(--text-muted); font-size: 0.85rem;">${service.type}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `).join('');

    const credentialsHtml = (this.currentData.credentials || []).map(cred => `
      <div style="border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem; margin-bottom: 0.5rem; background: var(--bg-dark);">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: var(--text); font-weight: bold;">${cred.id}</span>
          <span style="color: var(--text-muted); font-size: 0.85rem;">${cred.type}</span>
        </div>
      </div>
    `).join('');

    this.previewContent.innerHTML = `
      <div style="margin-bottom: 2rem;">
        <h2 style="color: var(--text); margin-bottom: 1rem;">Серверы (${(this.currentData.servers || []).length})</h2>
        ${serversHtml || '<div style="color: var(--text-muted); font-style: italic;">Нет серверов</div>'}
      </div>
      
      <div style="margin-bottom: 2rem;">
        <h2 style="color: var(--text); margin-bottom: 1rem;">Учетные данные (${(this.currentData.credentials || []).length})</h2>
        ${credentialsHtml || '<div style="color: var(--text-muted); font-style: italic;">Нет учетных данных</div>'}
      </div>
      
      <div>
        <h2 style="color: var(--text); margin-bottom: 1rem;">Настройки опроса</h2>
        <div style="border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem; background: var(--bg-dark);">
          <div style="color: var(--text); margin-bottom: 0.25rem;">Интервал: ${this.currentData.poll?.intervalSec || 'не задан'} сек</div>
          <div style="color: var(--text);">Параллельность: ${this.currentData.poll?.concurrency || 'не задана'}</div>
        </div>
      </div>
    `;
  }

  switchTab(tabName) {
    this.tabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    if (tabName === 'json') {
      this.jsonTab.style.display = 'flex';
      this.previewTab.style.display = 'none';
      this.aiConfigTab.style.display = 'none';
    } else if (tabName === 'preview') {
      this.jsonTab.style.display = 'none';
      this.previewTab.style.display = 'flex';
      this.aiConfigTab.style.display = 'none';
      this.updatePreview();
    } else if (tabName === 'ai-config') {
      this.jsonTab.style.display = 'none';
      this.previewTab.style.display = 'none';
      this.aiConfigTab.style.display = 'flex';
      this.loadAiConfig();
    }
  }

  addServer() {
    const newServer = {
      id: "new-server",
      name: "Новый сервер",
      env: "test",
      ssh: {
        host: "127.0.0.1",
        port: 22,
        user: "ubuntu",
        credentialId: "cred-sample"
      },
      services: [
        {
          id: "web",
          type: "http",
          name: "Web",
          url: "http://127.0.0.1:80/",
          expectStatus: 200,
          timeoutMs: 2000
        }
      ]
    };

    try {
      const data = JSON.parse(this.getEditorValue());
      if (!data.servers) data.servers = [];
      data.servers.push(newServer);

      const formatted = JSON.stringify(data, null, 2);
      this.setEditorValue(formatted);
      this.onEditorChange();
      this.jumpToServer(newServer.id);

    } catch (error) {
      alert('Ошибка добавления сервера: ' + error.message);
    }
  }

  addCredential() {
    const newCredential = {
      id: "new-credential",
      type: "ssh-key",
      privateKeyPath: "${SSH_KEY_PATH}",
      passphrase: "${SSH_PASSPHRASE}",
      password: "${SSH_PASSWORD}",
      useAgent: "${USE_SSH_AGENT}"
    };

    try {
      const data = JSON.parse(this.getEditorValue());
      if (!data.credentials) data.credentials = [];
      data.credentials.push(newCredential);

      const formatted = JSON.stringify(data, null, 2);
      this.setEditorValue(formatted);
      this.onEditorChange();

    } catch (error) {
      alert('Ошибка добавления учетных данных: ' + error.message);
    }
  }

  confirmReload() {
    this.showModal(
      'Перезагрузить файл?',
      'Все несохраненные изменения будут потеряны. Продолжить?',
      () => this.loadInventory()
    );
  }

  showModal(title, message, onConfirm) {
    this.modalTitle.textContent = title;
    this.modalMessage.textContent = message;
    this.confirmModal.classList.add('show');
    this.pendingAction = onConfirm;
  }

  hideModal() {
    this.confirmModal.classList.remove('show');
    this.pendingAction = null;
  }

  confirmAction() {
    if (this.pendingAction) {
      this.pendingAction();
    }
    this.hideModal();
  }

  setSaveStatus(type, message) {
    this.saveStatus.textContent = message;
    this.saveDot.className = `save-dot ${type}`;

    if (type === 'saved') {
      this.saveBtn.disabled = false;
    } else if (type === 'saving') {
      this.saveBtn.disabled = true;
    } else if (type === 'modified') {
      this.saveBtn.disabled = false;
    }
  }

  // Вспомогательные методы для работы с редактором
  getEditorValue() {
    if (this.codeMirror) {
      return this.codeMirror.getValue();
    } else {
      // Показываем textarea если CodeMirror не работает
      this.jsonEditor.style.display = 'block';
      return this.jsonEditor.value;
    }
  }

  setEditorValue(value) {
    if (this.codeMirror) {
      this.codeMirror.setValue(value);
    } else {
      // Показываем textarea если CodeMirror не работает
      this.jsonEditor.style.display = 'block';
    }
    this.jsonEditor.value = value;
  }

  // AI Config methods
  async reloadConfig() {
    try {
      this.setSaveStatus('loading', 'Reloading config...');
      const response = await fetch('/api/reload-config', { method: 'POST' });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();
      this.setSaveStatus('saved', result.message || 'Config reloaded');
      alert('Config.json reloaded successfully!');

    } catch (error) {
      console.error('Failed to reload config:', error);
      this.setSaveStatus('error', 'Reload failed');
      alert('Failed to reload config: ' + error.message);
    }
  }

  async loadAiConfig() {
    try {
      const response = await fetch('/api/config');

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const config = await response.json();

      // Fill form fields
      const form = this.aiConfigForm;
      Object.keys(config).forEach(key => {
        const input = form.querySelector(`[name="${key}"]`);
        if (input) {
          input.value = config[key] || '';
        }
      });

    } catch (error) {
      console.error('Failed to load AI config:', error);
      alert('Failed to load AI config: ' + error.message);
    }
  }

  async saveAiConfig(event) {
    if (event) event.preventDefault();


    try {
      this.setSaveStatus('saving', 'Сохранение AI конфигурации...');

      const form = this.aiConfigForm;
      const formData = new FormData(form);
      const config = {};

      // Convert FormData to plain object
      for (const [key, value] of formData.entries()) {
        config[key] = value;
      }

      const response = await fetch('/api/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(config)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      this.setSaveStatus('saved', 'AI config сохранен');

    } catch (error) {
      console.error('Failed to save AI config:', error);
      this.setSaveStatus('error', 'Ошибка сохранения');
      alert('Failed to save AI config: ' + error.message);
    }
  }
}

// Глобальная переменная для доступа из onclick в HTML
let editor;

// Инициализация после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  editor = new InventoryEditor();
});

// Утилиты
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    console.log('Скопировано в буфер обмена:', text);
  }).catch(err => {
    console.error('Ошибка копирования:', err);
  });
}
