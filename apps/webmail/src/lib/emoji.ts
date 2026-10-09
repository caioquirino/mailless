/*
 * Emoji a message can carry, each with a name to find it by and to say it
 * aloud. They are ordinary characters, not pictures, so they go in a message
 * as text and every mail program shows them in its own style. Only ones
 * that have been around since 2019 or earlier (Unicode 12 and before), each
 * a single character without a skin tone or a joined sequence, since those
 * are what an older program may show as two symbols or an empty box.
 */

export interface Emoji {
  char: string;
  name: string;
}

export interface EmojiGroup {
  name: string;
  emoji: readonly Emoji[];
}

const group = (name: string, list: string): EmojiGroup => ({
  name,
  emoji: list.split('|').map((each) => {
    const space = each.indexOf(' ');
    return { char: each.slice(0, space), name: each.slice(space + 1) };
  }),
});

export const EMOJI: readonly EmojiGroup[] = [
  group(
    'Faces',
    '😀 grinning|😃 big smile|😄 smiling eyes|😁 beaming|😆 laughing|😅 nervous laugh|😂 tears of joy|🙂 slight smile|🙃 upside down|😉 wink|😊 blushing smile|😇 halo|😍 heart eyes|😘 blowing a kiss|😋 yum|😛 tongue out|😜 winking tongue|🤔 thinking|🤨 raised eyebrow|😐 neutral|😑 expressionless|😶 speechless|🙄 rolling eyes|😏 smirk|😬 grimace|😌 relieved|😴 sleeping|😷 face mask|🤒 ill with thermometer|🤕 bandaged head|😎 sunglasses|🤓 nerd|😕 confused|😟 worried|🙁 slight frown|😮 surprised|😲 astonished|😳 flushed|😢 crying|😭 sobbing|😱 scream|😞 disappointed|😓 downcast sweat|😩 weary|😫 tired|😤 huffing|😡 furious|😠 angry|🤯 mind blown|🤗 hug|🤫 shush|🤭 oops',
  ),
  group(
    'Hands and people',
    '👍 thumbs up|👎 thumbs down|👌 OK|✌️ victory|🤞 fingers crossed|🤝 handshake|👏 clapping|🙌 hooray|🙏 thank you please|💪 strong|👋 waving hello|🤷 shrug|🤦 facepalm|👀 eyes looking|👉 pointing right|👈 pointing left|👆 pointing up|👇 pointing down|✍️ writing',
  ),
  group(
    'Symbols',
    '❤️ red heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|💔 broken heart|💯 hundred|✅ done check|❌ cross no|⚠️ warning|❓ question|❗ exclamation|⭐ star|✨ sparkles|🔥 fire|🎉 party celebration|🎊 confetti|💡 idea light bulb|📌 pin|📎 paperclip attachment|🔗 link|🔒 locked|🔑 key|💬 speech comment|⏰ alarm clock|⏳ hourglass waiting|📅 calendar date|🚀 rocket launch|🎯 target|🏆 trophy|🎁 gift present|💰 money',
  ),
  group(
    'Things and places',
    '☀️ sun|🌧️ rain|⛄ snowman|🌈 rainbow|🌍 world globe|🌱 seedling|🌹 rose flower|🍀 clover luck|☕ coffee|🍺 beer|🍷 wine|🍕 pizza|🎂 birthday cake|🍎 apple|✈️ airplane flight|🚗 car|🚆 train|🏠 house home|🏢 office|📞 phone call|📧 e-mail|💻 laptop computer|📱 mobile phone|📷 camera photo|🎵 music|⚽ football|🐶 dog|🐱 cat',
  ),
];

/** The emoji whose name has every word of what was typed in it. */
export function findEmoji(typed: string): Emoji[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  return EMOJI.flatMap((each) => each.emoji).filter((emoji) =>
    words.every((word) => emoji.name.toLowerCase().includes(word)),
  );
}
