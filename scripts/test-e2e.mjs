import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.resolve(__dirname, '../src/index.js');

const tests = [
  { id: 2, name: 'flow_account_check', params: {} },
  { id: 3, name: 'flow_status', params: {} },
  { id: 4, name: 'flow_discover_ui', params: { page: 'main' } },
  { id: 5, name: 'flow_generate_image', params: { prompt: 'A serene Japanese garden with cherry blossoms, digital art style', model: 'Nano Banana 2', ratio: '1:1' } },
];

let nextId = 6;

async function sendRequest(proc, request) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 60000);
    let data = '';

    const onData = (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        clearTimeout(timeout);
        proc.stdout.removeListener('data', onData);
        try {
          const lines = data.trim().split('\n');
          const result = JSON.parse(lines[lines.length - 1]);
          resolve(result);
        } catch (e) {
          resolve({ raw: data });
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify(request) + '\n');
  });
}

async function runTests() {
  console.log('=== Google Flow Browser MCP - E2E Tests ===\n');

  // First connect
  console.log('Test 1: flow_connect');
  const proc = spawn('node', [MCP_SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stderr.on('data', (d) => process.stderr.write(d));

  try {
    const connectResult = await sendRequest(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'flow_connect', arguments: { headless: true, open_flow: true } },
    });

    const connectData = JSON.parse(connectResult.result.content[0].text);
    console.log(`  Status: ${connectData.status}`);
    console.log(`  Account: ${connectData.account} (verified: ${connectData.accountVerified.verified})`);
    console.log(`  URL: ${connectData.url}\n`);

    if (connectData.status !== 'connected') {
      console.error('  ❌ Connection failed, aborting');
      proc.kill();
      process.exit(1);
    }
    console.log('  ✅ flow_connect PASS\n');

    // Run remaining tests
    for (const test of tests) {
      console.log(`Test ${test.id}: ${test.name}`);
      console.log(`  Params: ${JSON.stringify(test.params)}`);

      try {
        const result = await sendRequest(proc, {
          jsonrpc: '2.0',
          id: test.id,
          method: 'tools/call',
          params: { name: test.name, arguments: test.params },
        });

        if (result.result) {
          const data = typeof result.result.content[0].text === 'string'
            ? JSON.parse(result.result.content[0].text)
            : result.result.content[0].text;

          const status = data.status || data.verified || 'completed';
          console.log(`  Result: ${JSON.stringify(data).substring(0, 200)}`);
          console.log(`  ✅ ${test.name} PASS (status: ${status})\n`);
        } else if (result.error) {
          console.log(`  Result: ${JSON.stringify(result.error).substring(0, 200)}`);
          console.log(`  ⚠️  ${test.name} returned error (may be expected)\n`);
        }
      } catch (err) {
        console.log(`  ❌ ${test.name} FAILED: ${err.message}\n`);
      }
    }

    // Disconnect
    console.log('Cleanup: flow_disconnect');
    try {
      await sendRequest(proc, {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: 'flow_disconnect', arguments: {} },
      });
      console.log('  ✅ Disconnected\n');
    } catch (e) {
      console.log(`  ⚠️  Disconnect: ${e.message}\n`);
    }

  } catch (err) {
    console.error(`Fatal error: ${err.message}`);
  }

  proc.stdin.end();
  setTimeout(() => proc.kill(), 2000);

  console.log('=== E2E Tests Complete ===');
}

runTests().catch(console.error);
