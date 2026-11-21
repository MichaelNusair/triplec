/**
 * A port nobody is listening on, for a test that boots a real server.
 *
 * The kernel picks it, which is what lets the test files run side by side
 * (`scripts/run-tests.mjs`): two files counting upward from fixed numbers, or one
 * rolling a random port in a forty-wide range, eventually land on each other, and
 * then one test talks to the other test's server. It also keeps the property
 * auth-test.js insists on, a fresh port per server, so a leftover process from an
 * earlier run cannot answer in place of the one under test.
 *
 * There is a moment between closing this socket and the server binding where
 * another process could take the port. The kernel does not hand a just-released
 * ephemeral port straight back out, and the server's bind would fail loudly rather
 * than quietly answering for someone else, so the gap costs a red run at worst.
 */
import { createServer } from 'net';

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
