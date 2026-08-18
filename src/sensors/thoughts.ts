export const THOUGHT_POOLS: Record<string, string[]> = {
  reading: [
    'Scanning the page...',
    'Looking around...',
    'Examining the content...',
    'Reading carefully...',
    'Checking the page...',
    'Taking a look...',
    'Let me see...',
    'Browsing the page...',
  ],
  clicking: [
    'Clicking...',
    'Tapping...',
    'Selecting...',
    'Pressing...',
    'Targeting element...',
    'Interacting...',
  ],
  typing: [
    'Typing...',
    'Writing...',
    'Entering text...',
    'Filling in...',
    'Inputting...',
    'Keying in...',
  ],
  navigating: [
    'Going there...',
    'Loading page...',
    'Navigating...',
    'Heading over...',
    'Opening page...',
    'Moving to...',
  ],
  thinking: [
    'Thinking...',
    'Figuring it out...',
    'Planning next step...',
    'Deciding...',
    'Considering options...',
    'Processing...',
    'Analyzing...',
  ],
  searching: [
    'Looking for...',
    'Searching...',
    'Finding...',
    'Scanning for...',
    'Hunting for...',
    'Locating...',
  ],
};

export function getRandomThought(state: string): string | null {
  const pool = THOUGHT_POOLS[state];
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
