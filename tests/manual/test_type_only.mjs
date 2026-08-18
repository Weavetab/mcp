import { loadConfigSync } from '../../src/config/loader.js';
import { getOrConnect } from '../../src/cdp/connector.js';
import { weaveType } from '../../src/tools/type.js';

try {
  const config = loadConfigSync();
  const client = await getOrConnect(config);
  const session = client.session;
  console.log('CONNECTED');

  await session.Page.navigate({ url: 'https://httpbin.org/forms/post' });
  await new Promise(r => setTimeout(r, 4000));
  console.log('NAVIGATED');

  const prom = weaveType(session, { id: 'input[name="custname"]', text: 'Hello' }, config);
  const result = await Promise.race([
    prom.then(r => ({ ok: true, data: r })),
    new Promise(r => setTimeout(() => r({ ok: false, data: 'TIMEOUT' })), 25000)
  ]);

  if (!result.ok) {
    console.error('TIMEOUT');
  } else {
    console.log('SUCCESS:', JSON.stringify(result.data).slice(0, 500));
  }

  await session.close();
} catch(e) {
  console.error('ERROR:', e.message);
  console.error(e.stack?.slice(0, 500));
}
process.exit(0);
