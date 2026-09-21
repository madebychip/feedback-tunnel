'use server';

let saves = 0;

// Next.js rejects server actions whose Origin doesn't match the Host it sees,
// which is exactly what a tunnel breaks. The proxy has to make this pass.
export async function save(name) {
  saves += 1;
  return `Saved ${name} (#${saves})`;
}
