// Bun/Node 18+ имеет встроенный fetch

const BASE_URL = 'http://localhost:3000/api/v2/terminal';
const SERVER_ID = 'usa';

async function runTestV2() {
  let sessionId;

  try {
    // Шаг 1: Создание сессии
    console.log(`[V2] Creating session for server: ${SERVER_ID}...`);
    const createSessionResponse = await fetch(`${BASE_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: SERVER_ID }),
    });

    const sessionResult = await createSessionResponse.json();
    if (!sessionResult.success) {
      throw new Error(`Failed to create session: ${sessionResult.error.message}`);
    }

    sessionId = sessionResult.data.sessionId;
    console.log(`[V2] Session created successfully. Session ID: ${sessionId}`);
    console.log('---');

    // Шаг 2: Выполнение ls -la
    console.log('[V2] Executing command: ls -la');
    const lsResponse = await fetch(`${BASE_URL}/sessions/${sessionId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'ls -la' }),
    });
    
    const lsResult = await lsResponse.json();
    if (!lsResult.success) {
        throw new Error(`Command 'ls -la' failed: ${lsResult.error.message}`);
    }

    console.log('STDOUT:\n', lsResult.data.stdout);
    console.error('STDERR:\n', lsResult.data.stderr);
    console.log(`Exit Code: ${lsResult.data.exitCode}`);
    console.log('---');

    // Шаг 3: Выполнение pwd
    console.log('[V2] Executing command: pwd');
    const pwdResponse = await fetch(`${BASE_URL}/sessions/${sessionId}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'pwd' }),
    });

    const pwdResult = await pwdResponse.json();
    if (!pwdResult.success) {
        throw new Error(`Command 'pwd' failed: ${pwdResult.error.message}`);
    }
    
    console.log('STDOUT:\n', pwdResult.data.stdout);
    console.error('STDERR:\n', pwdResult.data.stderr);
    console.log(`Exit Code: ${pwdResult.data.exitCode}`);
    console.log('---');

  } catch (error) {
    console.error('[V2] An error occurred during the test:', error.message);
  } finally {
    // Шаг 4: Закрытие сессии
    if (sessionId) {
      console.log(`[V2] Closing session: ${sessionId}...`);
      try {
        const closeSessionResponse = await fetch(`${BASE_URL}/sessions/${sessionId}`, {
          method: 'DELETE',
        });
        const closeResult = await closeSessionResponse.json();
        if (closeResult.success) {
            console.log(closeResult.data.message || '[V2] Session closed.');
        } else {
            console.error(`[V2] Failed to close session: ${closeResult.error.message}`);
        }
      } catch (closeError) {
        console.error('[V2] Error during session closing:', closeError.message);
      }
    }
  }
}

runTestV2();
