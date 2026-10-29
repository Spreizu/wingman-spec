export const sent = [];
export function send(to, subject) {
  if (!to.includes('@')) throw new Error('bad address');
  sent.push({ to, subject });
}
