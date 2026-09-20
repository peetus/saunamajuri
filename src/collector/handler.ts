export const handler = async (): Promise<{ ok: boolean }> => {
  console.log('collector ran');
  return { ok: true };
};
