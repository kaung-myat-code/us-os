import { prisma } from '../src/client';

async function main(): Promise<void> {
  console.log('No domain models exist yet, so there is nothing to seed in this foundation phase.');
  console.log('Feature phases that add Prisma models should extend this function with real seed data.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
