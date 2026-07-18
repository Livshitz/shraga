import { summarizeConversations } from '../server/conversation-summarizer.ts';

const force = process.argv.includes('--force');
const result = await summarizeConversations({ force });
console.log(`Done: ${result.summarized} summarized, ${result.tracesGenerated} traces, ${result.skipped} skipped, ${result.errors} errors`);
