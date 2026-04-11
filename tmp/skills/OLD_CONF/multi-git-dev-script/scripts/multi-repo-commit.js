const { exec, execSync } = require('child_process');
const path = require('path');
const readline = require('readline');
const fs = require('fs');

const folders = [
  'C:\\ERV\\projects-ex\\kosmos-model',
  'C:\\ERV\\projects-ex\\kosmos-vector',
  'C:\\ERV\\projects-ex\\kosmos-vector-UI'
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => {
    rl.question(query + '\n> ', resolve);
  });
}

function runCommand(cmd, cwd, sync = false) {
  const options = { cwd, encoding: 'utf8', shell: true };

  if (sync) {
    try {
      return execSync(cmd, options).trim();
    } catch (err) {
      throw new Error(`Command failed: ${cmd}\n${err.stderr || err.message}`);
    }
  } else {
    return new Promise((resolve, reject) => {
      exec(cmd, options, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${cmd}\n${stderr || error.message}`));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }
}

async function processRepo(folder) {
  console.log(`\n=== Обрабатываем: ${folder} ===`);

  try {
    // 1. Проверка текущей ветки
    const currentBranch = runCommand('git branch --show-current', folder, true);
    if (currentBranch !== 'dev') {
      console.log(`Ошибка: текущая ветка — ${currentBranch} (нужна dev). Пропускаем.`);
      return { status: 'skipped-branch' };
    }

    // 2. Проверка наличия изменений
    let status = runCommand('git status --short', folder, true);
    if (!status) {
      console.log('Нет изменений. Пропускаем.');
      return { status: 'skipped-no-changes' };
    }

    console.log('Найдены изменения:');
    console.log(status);

    const message = await askQuestion(
      'Введи сообщение для коммита (или "skip", чтобы пропустить эту папку):'
    );

    const trimmed = message.trim();
    if (!trimmed || trimmed.toLowerCase() === 'skip') {
      console.log('Пропущено по желанию пользователя.');
      return { status: 'skipped-manual' };
    }

    // 3. git add . && git commit && git push
    console.log('→ git add .');
    runCommand('git add .', folder, true);

    console.log(`→ git commit -m "${trimmed.replace(/"/g, '\\"')}"`);
    const commitOutput = runCommand(
      `git commit -m "${trimmed.replace(/"/g, '\\"')}"`,
      folder,
      true
    );
    console.log(commitOutput || '(commit выполнен без вывода)');

    console.log('→ git push origin dev');
    const pushOutput = await runCommand('git push origin dev', folder);
    console.log(pushOutput || '(push выполнен)');

    return { status: 'success' };
  } catch (err) {
    console.error('Ошибка в этой папке:', err.message);
    return { status: 'error', error: err.message };
  }
}

async function main() {
  console.log('Multi-repo commit & push (только ветка dev)\n');
  console.log('Папки для обработки:');
  folders.forEach(f => console.log('  ' + f));
  console.log('');

  let success = 0;
  let skipped = 0;
  let errors = 0;

  for (const folder of folders) {
    if (!fs.existsSync(folder)) {
      console.log(`Папка не существует: ${folder} → пропускаем`);
      errors++;
      continue;
    }

    const result = await processRepo(folder);

    if (result.status === 'success') success++;
    else if (result.status.startsWith('skipped')) skipped++;
    else errors++;
  }

  console.log('\n=== Итог ===');
  console.log(`Папок всего: ${folders.length}`);
  console.log(`Успешно закоммичено и запушено: ${success}`);
  console.log(`Пропущено (ошибка ветки / нет изменений / skip): ${skipped}`);
  console.log(`С ошибками: ${errors}`);

  rl.close();
}

main()
  .catch(err => {
    console.error('\nКритическая ошибка:', err.message);
    rl.close();
  });