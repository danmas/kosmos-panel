const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3000/api/v1/terminal';
const SERVER_ID = 'usa';

async function runTest() {
  let sessionId;

  try {
    // Шаг 1: Создание сессии
    console.log(`Creating session for server: ${SERVER_ID}...`);
    const createSessionResponse = await fetch(`${BASE_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: SERVER_ID }),
    });

    if (!createSessionResponse.ok) {
      throw new Error(`Failed to create session: ${createSessionResponse.status} ${await createSessionResponse.text()}`);
    }

    const sessionData = await createSessionResponse.json();
    sessionId = sessionData.sessionId;
    console.log(`Session created successfully. Session ID: ${sessionId}`);
    console.log('---');

    // Шаг 2: Выполнение ls -la
    console.log('Executing command: ls -la');
    const lsResponse = await fetch(`${BASE_URL}/sessions/${sessionId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'ls -la' }),
    });
    
    const lsResult = await lsResponse.json();
    console.log('STDOUT:\n', lsResult.stdout);
    console.error('STDERR:\n', lsResult.stderr);
    console.log(`Exit Code: ${lsResult.exitCode}`);
    console.log('---');

    // Шаг 3: Выполнение pwd
    console.log('Executing command: pwd');
    const pwdResponse = await fetch(`${BASE_URL}/sessions/${sessionId}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'pwd' }),
    });

    const pwdResult = await pwdResponse.json();
    console.log('STDOUT:\n', pwdResult.stdout);
    console.error('STDERR:\n', pwdResult.stderr);
    console.log(`Exit Code: ${pwdResult.exitCode}`);
    console.log('---');

  } catch (error) {
    console.error('An error occurred during the test:', error.message);
  } finally {
    // Шаг 4: Закрытие сессии
    if (sessionId) {
      console.log(`Closing session: ${sessionId}...`);
      try {
        const closeSessionResponse = await fetch(`${BASE_URL}/sessions/${sessionId}`, {
          method: 'DELETE',
        });
        const closeData = await closeSessionResponse.json();
        console.log(closeData.message || 'Session closed.');
      } catch (closeError) {
        console.error('Failed to close session:', closeError.message);
      }
    }
  }
}

runTest();
