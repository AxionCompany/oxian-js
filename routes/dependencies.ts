export default async function () {
  const users = new Map<string, { id: string; name: string }>([
    ["1", { id: "1", name: "Ada" }],
    ["2", { id: "2", name: "Linus" }],
  ]);
  const db = { users };
  
  return { db } as const;
} 