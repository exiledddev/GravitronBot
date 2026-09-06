require('dotenv').config();
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  ChatInputBuilder,
  TextInputStyle, roleMention, channelMention, MessageFlags,
} = require('discord.js');
const cron = require('node-cron');
const { version: BOT_VERSION } = require('./package.json');

const token = process.env.DISCORD_TOKEN;
const MAX_RECENT_CONSOLE_ERRORS = 5;
const recentConsoleErrors = [];

if (!token) {
  console.error('Missing DISCORD_TOKEN in .env file.');
  process.exit(1);
}

const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  const formatted = args.map((arg) => {
    if (arg instanceof Error) {
      return arg.stack || arg.message;
    }
    if (typeof arg === 'string') {
      return arg;
    }
    try {
      return JSON.stringify(arg);
    } catch (error) {
      return String(arg);
    }
  }).join(' ');

  recentConsoleErrors.push(`[${new Date().toISOString()}] ${formatted}`);
  if (recentConsoleErrors.length > MAX_RECENT_CONSOLE_ERRORS) {
    recentConsoleErrors.shift();
  }

  originalConsoleError(...args);
};

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.MessageContent,
];

const client = new Client({
  intents,
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  for (const schedule of CHAT_REVIVE_SCHEDULES) {
    cron.schedule(
      schedule,
      async () => {
        for (const guild of readyClient.guilds.cache.values()) {
          try {
            await sendChatRevivePing(guild);
          } catch (error) {
            console.error(`Failed to send chat revive message in guild ${guild.id}:`, error);
          }
        }
      },
      { timezone: 'Etc/GMT-3' },
    );
  }

  try {
    const startupChannel = await readyClient.channels.fetch(STARTUP_CHANNEL_ID);
    if (startupChannel?.isTextBased()) {
      await startupChannel.send({ embeds: [buildStartupEmbed(readyClient)] });
    }
  } catch (error) {
    console.error('Failed to send bot start-up message:', error);
  }
});

const APPLY_BUTTON_ID = 'actor_apply_open';
const BUILDER_BUTTON_ID = 'builder_apply_open';
const STAFF_BUTTON_ID = 'staff_apply_open';
const TEAM_BUTTON_ID = 'team_apply_open';
const SUPPORT_BUTTON_ID = 'support_ticket_open';
const APPLY_MODAL_ID = 'actor_apply_form';
const BUILDER_MODAL_ID = 'builder_apply_form';
const STAFF_MODAL_ID = 'staff_apply_form';
const TEAM_MODAL_ID = 'team_apply_form';
const SUPPORT_MODAL_ID = 'support_ticket_form';
const ACTOR_TOPIC_PREFIX = 'actor-app:user:';
const BUILDER_TOPIC_PREFIX = 'builder-app:user:';
const STAFF_TOPIC_PREFIX = 'staff-app:user:';
const TEAM_TOPIC_PREFIX = 'team-app:user:';
const SUPPORT_TOPIC_PREFIX = 'support-ticket:user:';
const TICKET_STATS_TYPES = [
  { key: 'actor', label: 'Actor', topicPrefix: ACTOR_TOPIC_PREFIX },
  { key: 'builder', label: 'Builder', topicPrefix: BUILDER_TOPIC_PREFIX },
  { key: 'staff', label: 'Staff', topicPrefix: STAFF_TOPIC_PREFIX },
  { key: 'team', label: 'Team', topicPrefix: TEAM_TOPIC_PREFIX },
  { key: 'support', label: 'Support', topicPrefix: SUPPORT_TOPIC_PREFIX },
];
const ALLOWED_USER_ID = '1273910593539014680';
const ADMIN_ROLE_ID = '1503739527804616836';
const ACTOR_ROLE_ID = '1503776275645337621';
const BUILDER_ROLE_ID = '1503778122275885121';
const ANTI_SPAM_CHANNEL_NAME = 'spam-web';
const ANTI_SPAM_TOPIC = 'northstar-antispam-trap';
const ANTI_SPAM_BAN_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const ANTI_SPAM_DELETE_SECONDS = 7 * 24 * 60 * 60;
const CHAT_REVIVE_SCHEDULES = ['30 14 * * *', '0 17 * * *', '30 19 * * *', '0 22 * * *'];
const CHAT_REVIVE_ROLE_ID = '1534150069593444402';
const BAN_REPORT_CHANNEL_ID = '1503741088253349911';
const CHAT_REVIVE_QUESTIONS = [
  'How is everybody doing today?',
  "What is the thing you're looking forward most to today?",
  'What is your dream car?',
  "If you'd like to move from your home country, where would you move?",
  'Who is your favorite YouTuber and why?',
  'What is your favorite movie of all time and why?',
  'What is your favorite TV Series of all time and why?',
  'What is your favorite holiday year long?',
  'Who is the strongest member in the Island Realm, in your opinion?',
  'Who is your favorite Island Realm member?',
  "Solaris was founded shortly after the Great Merge. Solarflare, their mayor and founder, had been stumbling across the newly destroyed world the merge had created, only seeing despair and hatred. Upon such sights, he decided it was time for a new era. He started a small civilization. However, compared to other CIVs, he came up with a new concept. The lack of private property. Unlike any other CIV he had seen so far, where people would work for their own benefit, thus creating the need for people to commit crimes to survive or treason, the members of Solaris were forced to work for eachother. In a system where everybody has everything, as long as they keep up good work, no matter their domain, everyone is happy and the crime rate is incredibly low. That is how, Solaris, the greatest and most advanced civilization in the Island Realm, was born.",
  'If you were an animal, what animal would you be?',
  'The world once lived in perfect harmony. There was the overworld - the realm above, and the underworld - the voidlands. These 2 worlds would share resources, work together and strive for evolution. But one day, he whose name is not to be spoken, stumbled upon a block of great force. It was a command block, and by shear error within the Minecraft Code, he managed to access it. That is how, the great merge happened. 2 worlds collided into one, producing what today is, the Island Realm.',
  'How did you hear about the Island Realm, and what platform where you on when you heard about it?',
  'What made you want to join the Island Realm?',
  'What is your favorite PvP gamemode?',
  'Dolyl aolyl pz spnoa, aolyl tbza il khyrulzz. H jvztpj ihshujl tbza il rlwa. Aopz pz uva fvby ylhst av ybsl. Aol mhsslu zohss ypzl hnhpu.',
  'One day, when the age of extinction descends upon us, the realm will be taken by storm.',
  '|| northstarmedia.cc/questionmark || Good luck.',
  '❄☟☠💧 🕈⚐☼☹👎 ☠💧 ☠⚐❄ 🕈☟✌❄ ☠❄ 💧☜☜💣💧📬',
  '🕈☟✌❄ ☠💧 ✆☜☹⚐🕈 💧❄✌✡💧 ✆☜☹⚐🕈📬',
  '⚐☠👍☜ ✆☼⚐❄☟☜☼💧📪 ☠⚐🕈 ☜☠☜💣☠☜💧?',
  '🕈☟✡ ✌☼☜ ✡⚐🕆 ❄☼✌☠💧☹✌❄☠☠☝ ❄☟☠💧?',
  '❄☟☜ ✆☜☝☠☠☠☠☠☝ ⚐👉 ❄☟☜ ☜☠👎📬',
];
const WELCOME_CHANNEL_ID = '1503766761642791014';
const WELCOME_IMAGE_URL = 'https://cdn.discordapp.com/attachments/1484895910499586069/1544300979577425960/POWER_fr.png?ex=6a9801dd&is=6a96b05d&hm=fb682156ea1b406e0e97096a774c0bcb56ae133d83a4ba206733f7a87ad0e583&';
const BOT_PING_SEQUENCE = [
  '↻ System Check Init...',
  '✅ Quantum Carburator Operational...',
  '✅ Microverse Battery Operational...',
  '✅ Self-Destruction Protocol on Standby...',
  '✦ All systems operational.',
  '➲ Northstar Utils on Standby.',
];
const BAN_DURATION_OPTIONS = {
  '1d': { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  '2d': { label: '2 days', ms: 2 * 24 * 60 * 60 * 1000 },
  '7d': { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  permanent: { label: 'Permanently', ms: null },
};
const PROJECT_ROLE_ID = '1521863459741106317';
const PROJECT_CATEGORY_ID = '1546079186425487420';
const PROJECT_TOPIC_PREFIX = 'northstar-project:';
const PROJECT_MEMBER_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.UseApplicationCommands,
];
const PROJECT_MEMBER_PERMISSION_OVERWRITE = {
  ViewChannel: true,
  SendMessages: true,
  ReadMessageHistory: true,
  AttachFiles: true,
  EmbedLinks: true,
  AddReactions: true,
  UseExternalEmojis: true,
  UseApplicationCommands: true,
};
const ACCEPTED_READ_FIRST_CHANNEL_ID = '1546086278418927656';
const ACCEPTED_QUESTIONS_CHANNEL_ID = '1546082814284533890';
const HOW_JOIN_CHANNEL_ID = '1506390449516974280';
const HOW_APPLY_CHANNEL_ID = '1507777195190517811';
const EVENT_STAGE_CHANNEL_ID = '1503754828558372894';
const EVENT_MAX_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
const STARTUP_CHANNEL_ID = '1503748268713054461';
const ANTI_SPAM_BAN_REASON = 'Bot catcher \u2013 Soft-ban automatically dispatched.';
const DURATION_UNIT_MS = {
  d: 86400000,
  day: 86400000,
  days: 86400000,
  h: 3600000,
  hr: 3600000,
  hrs: 3600000,
  hour: 3600000,
  hours: 3600000,
  m: 60000,
  min: 60000,
  mins: 60000,
  minute: 60000,
  minutes: 60000,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
};

function getRandomQuestion() {
  return CHAT_REVIVE_QUESTIONS[Math.floor(Math.random() * CHAT_REVIVE_QUESTIONS.length)];
}

function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function buildWelcomeEmbed(user) {
  return new EmbedBuilder()
    .setTitle(`Hello ${user.tag}! Welcome to __Island Realm__!`)
    .setDescription('Here is some help to get you started:')
    .addFields(
      {
        name: 'Information regarding our server (please read)',
        value: 'https://discord.com/channels/1503735346817532024/1506390449516974280',
      },
      {
        name: 'Apply for our series',
        value: 'https://discord.com/channels/1503735346817532024/1507777195190517811',
      },
      {
        name: 'Selectable roles',
        value: 'https://discord.com/channels/1503735346817532024/1534150990381584474',
      },
      {
        name: '───────────────',
        value: '\u200b',
      },
      {
        name: 'Quick description of them',
        value: 'By joining the Island Realm, you automatically agree to the following:',
      },
      {
        name: 'Our rules',
        value: 'https://discord.com/channels/1503735346817532024/1503741088253349908',
      },
      {
        name: 'Terms of Service',
        value: '[Read here](https://www.northstarmedia.cc/terms)',
      },
      {
        name: 'Privacy Policy',
        value: '[Read here](https://www.northstarmedia.cc/privacy)',
      },
    )
    .setFooter({ text: 'Need help? Open a ticket: https://discord.com/channels/1503735346817532024/1544102274941591622' })
    .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 1024 }))
    .setImage(WELCOME_IMAGE_URL)
    .setColor(0x242429);
}

async function sendChatRevivePing(guild) {
  const reviveChannel = guild.channels.cache.get('1503735347480100877');
  if (!reviveChannel) return;

  await reviveChannel.send(
    `${roleMention(CHAT_REVIVE_ROLE_ID)} Chat Revive Time! ${getRandomQuestion()}`,
  );
}

function isAuthorized(interaction) {
  return (
    interaction.user?.id === ALLOWED_USER_ID ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

function isAntiSpamTrapChannel(channel) {
  return (
    channel?.type === ChannelType.GuildText &&
    channel.name === ANTI_SPAM_CHANNEL_NAME &&
    channel.topic === ANTI_SPAM_TOPIC
  );
}

function sanitizeChannelPart(value) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return sanitized || 'applicant';
}

function parseUserIdFromInput(value) {
  const trimmedValue = value.trim();
  const mentionMatch = trimmedValue.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  if (/^\d+$/.test(trimmedValue)) {
    return trimmedValue;
  }

  return null;
}

function generateBanId() {
  const timestampPart = Date.now().toString(36).toUpperCase();
  const randomPart = Math.floor(Math.random() * 1679616).toString(36).toUpperCase().padStart(4, '0');
  return `${timestampPart}-${randomPart}`;
}

function getUniqueActorChannelName(guild, usernamePart) {
  const base = `🎭actor-${usernamePart}`.slice(0, 100);
  let candidate = base;
  let index = 2;

  while (guild.channels.cache.some((channel) => channel.name === candidate) && index < 100) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    index += 1;
  }

  return candidate;
}

function getUniqueBuilderChannelName(guild, usernamePart) {
  const base = `🪴builder-${usernamePart}`.slice(0, 100);
  let candidate = base;
  let index = 2;

  while (guild.channels.cache.some((channel) => channel.name === candidate) && index < 100) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    index += 1;
  }

  return candidate;
}

function getUniqueStaffChannelName(guild, usernamePart) {
  const base = `🛡staff-${usernamePart}`.slice(0, 100);
  let candidate = base;
  let index = 2;

  while (guild.channels.cache.some((channel) => channel.name === candidate) && index < 100) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    index += 1;
  }

  return candidate;
}

function getUniqueTeamChannelName(guild, usernamePart) {
  const base = `💼team-${usernamePart}`.slice(0, 100);
  let candidate = base;
  let index = 2;

  while (guild.channels.cache.some((channel) => channel.name === candidate) && index < 100) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    index += 1;
  }

  return candidate;
}

function getUniqueSupportChannelName(guild, usernamePart) {
  const base = `🆘support-${usernamePart}`.slice(0, 100);
  let candidate = base;
  let index = 2;

  while (guild.channels.cache.some((channel) => channel.name === candidate) && index < 100) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    index += 1;
  }

  return candidate;
}

function findExistingActorApplicationChannel(guild, userId) {
  const marker = `${ACTOR_TOPIC_PREFIX}${userId}`;

  return guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      typeof channel.topic === 'string' &&
      channel.topic.startsWith(marker),
  );
}

function findExistingBuilderApplicationChannel(guild, userId) {
  const marker = `${BUILDER_TOPIC_PREFIX}${userId}`;

  return guild.channels.cache.find(
      (channel) =>
          channel.type === ChannelType.GuildText &&
          typeof channel.topic === 'string' &&
          channel.topic.startsWith(marker),
  );
}

function findExistingStaffApplicationChannel(guild, userId) {
  const marker = `${STAFF_TOPIC_PREFIX}${userId}`;

  return guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        typeof channel.topic === 'string' &&
        channel.topic.startsWith(marker),
  );
}

function findExistingTeamApplicationChannel(guild, userId) {
  const marker = `${TEAM_TOPIC_PREFIX}${userId}`;

  return guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        typeof channel.topic === 'string' &&
        channel.topic.startsWith(marker),
  );
}

function findExistingSupportTicketChannel(guild, userId) {
  const marker = `${SUPPORT_TOPIC_PREFIX}${userId}`;

  return guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        typeof channel.topic === 'string' &&
        channel.topic.startsWith(marker),
  );
}

function getOpenTicketStats(guild) {
  const counts = Object.fromEntries(TICKET_STATS_TYPES.map((type) => [type.key, 0]));

  for (const channel of guild.channels.cache.values()) {
    if (
      channel.type !== ChannelType.GuildText ||
      typeof channel.topic !== 'string' ||
      !channel.topic.includes(':status:open')
    ) {
      continue;
    }

    const matchingType = TICKET_STATS_TYPES.find((type) => channel.topic.startsWith(type.topicPrefix));
    if (matchingType) {
      counts[matchingType.key] += 1;
    }
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { counts, total };
}

function getApplicantIdFromChannel(channel) {
  const channelTopic = channel?.topic || '';
  const topicPrefixes = [
    ACTOR_TOPIC_PREFIX,
    BUILDER_TOPIC_PREFIX,
    STAFF_TOPIC_PREFIX,
    TEAM_TOPIC_PREFIX,
    SUPPORT_TOPIC_PREFIX,
  ];
  let topicMatch = null;
  for (const prefix of topicPrefixes) {
    topicMatch = channelTopic.match(new RegExp(`^${prefix}(\\d+)`));
    if (topicMatch) break;
  }

  return topicMatch ? topicMatch[1] : null;
}

function sanitizeProjectChannelName(value) {
  const sanitized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return sanitized || 'project';
}

function getUniqueProjectChannelName(guild, projectName) {
  const base = sanitizeProjectChannelName(projectName).slice(0, 100);
  let candidate = base;
  let index = 2;

  while (guild.channels.cache.some((channel) => channel.name === candidate) && index < 100) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    index += 1;
  }

  return candidate;
}

function isProjectChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildText) {
    return false;
  }

  if (typeof channel.topic === 'string' && channel.topic.startsWith(PROJECT_TOPIC_PREFIX)) {
    return true;
  }

  return channel.parentId === PROJECT_CATEGORY_ID;
}

async function hasProjectRole(interaction) {
  if (interaction.user?.id === ALLOWED_USER_ID) {
    return true;
  }

  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const memberRoles = interaction.member?.roles;
  if (memberRoles?.cache?.has(PROJECT_ROLE_ID)) {
    return true;
  }

  if (Array.isArray(memberRoles) && memberRoles.includes(PROJECT_ROLE_ID)) {
    return true;
  }

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    return member.roles.cache.has(PROJECT_ROLE_ID);
  } catch (error) {
    console.error('Failed to resolve member roles for project authorization:', error);
    return false;
  }
}

async function resolveGuildTextChannel(guild, channelId) {
  if (!guild) {
    return null;
  }

  const cachedChannel = guild.channels.cache.get(channelId);
  if (cachedChannel) {
    return cachedChannel.isTextBased?.() ? cachedChannel : null;
  }

  try {
    const fetchedChannel = await guild.channels.fetch(channelId);
    return fetchedChannel?.isTextBased?.() ? fetchedChannel : null;
  } catch (error) {
    console.error(`Failed to resolve channel ${channelId}:`, error);
    return null;
  }
}

function truncateForEmbed(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function buildBanReportEmbed({ inputUserArgument, durationLabel, deleteMessages, userId, reason, banTag }) {
  return new EmbedBuilder()
    .setTitle('Action Report - Ban Issued')
    .setDescription(truncateForEmbed(
      [
        `**Input User Argument:** ${inputUserArgument}`,
        `**Duration:** ${durationLabel}`,
        `**Delete Messages:** ${deleteMessages ? 'Yes' : 'No'}`,
        `**Banned User:** <@${userId}>`,
        `**Banned User ID:** ${userId}`,
        '',
        '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
        `**Reason:** ${reason}`,
      ].join('\n'),
      4096,
    ))
    .setColor(0xFF0000)
    .setFooter({ text: banTag });
}

async function sendAlertChannelEmbed(guild, embed) {
  const alertChannel = await resolveGuildTextChannel(guild, BAN_REPORT_CHANNEL_ID);
  if (!alertChannel) {
    return;
  }

  try {
    await alertChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Failed to send alert channel embed:', error);
  }
}

async function closeTicketChannel(guild, channelId, applicantId, closeMessage) {
  if (applicantId) {
    try {
      const applicantMember = await guild.members.fetch(applicantId);
      await applicantMember.send(closeMessage || 'Your ticket in Island SMP has been closed.');
    } catch (error) {
      console.error('Failed to send ticket closure DM to applicant:', error);
    }
  }

  try {
    await guild.channels.delete(channelId, 'Northstar Utils ticket closed.');
    return true;
  } catch (error) {
    console.error('Failed to delete ticket channel:', error);
    return false;
  }
}

function buildAcceptanceEmbed(applicantId, programLabel) {
  return new EmbedBuilder()
    .setTitle('\ud83c\udf89 Application Accepted')
    .setDescription(
      [
        `Congratulations <@${applicantId}>!`,
        '',
        `You have been accepted for our **${programLabel}** program!`,
        '',
        `Before you do anything, please read: ${channelMention(ACCEPTED_READ_FIRST_CHANNEL_ID)}`,
        '',
        `If you have any questions, please tag one of our admins in ${channelMention(ACCEPTED_QUESTIONS_CHANNEL_ID)} and ask them!`,
      ].join('\n'),
    )
    .setColor(0x242429)
    .setFooter({ text: 'Island Realm \u2013 Northstar Media' })
    .setTimestamp();
}

function parseTimeUntilEvent(input) {
  const compact = String(input ?? '').trim().toLowerCase().replace(/[\s,]/g, '');
  if (!compact) {
    return null;
  }

  const unitPattern = /(\d+(?:\.\d+)?)(days|day|d|hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)/g;
  let totalMs = 0;
  let consumedLength = 0;
  let match = unitPattern.exec(compact);

  while (match !== null) {
    totalMs += Number.parseFloat(match[1]) * DURATION_UNIT_MS[match[2]];
    consumedLength += match[0].length;
    match = unitPattern.exec(compact);
  }

  if (consumedLength !== compact.length) {
    if (!/^\d+(?:\.\d+)?$/.test(compact)) {
      return null;
    }

    // A bare number is treated as minutes.
    totalMs = Number.parseFloat(compact) * DURATION_UNIT_MS.m;
  }

  totalMs = Math.round(totalMs);
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return null;
  }

  return totalMs;
}

function formatDurationLabel(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds && !days && !hours) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);

  return parts.length ? parts.join(' ') : '0 minutes';
}

function buildEventEmbed({ isLive, startTimestampSeconds, ip, version, players }) {
  const timeFieldValue = isLive ?
    `\ud83d\udd34 **LIVE NOW** \u2013 started <t:${startTimestampSeconds}:R>` :
    `<t:${startTimestampSeconds}:R>\n<t:${startTimestampSeconds}:F>`;

  const description = isLive ?
    [
      '# \ud83d\udd34 THE RECORDING EVENT IS LIVE',
      `## \u27a1\ufe0f Join: ${channelMention(EVENT_STAGE_CHANNEL_ID)} to be in the video.`,
    ].join('\n') :
    [
      '# \u26a0\ufe0f READ THIS BEFORE THE EVENT',
      `## \u27a1\ufe0f To participate, join: ${channelMention(EVENT_STAGE_CHANNEL_ID)} or you will miss out on instructions and get banned.`,
      '**All instructions will be listed in the stage channel by one of our Production Managers.**',
    ].join('\n');

  return new EmbedBuilder()
    .setTitle(isLive ? 'RECORDING EVENT LIVE' : 'Recording Event Planned')
    .setDescription(description)
    .addFields(
      { name: 'Time Till Event', value: timeFieldValue, inline: false },
      { name: 'IP For Event', value: truncateForEmbed(`\`${ip}\``, 1024), inline: true },
      { name: 'Version', value: `\`${version}\``, inline: true },
      { name: 'Amount Of Players Needed', value: `**${players}**`, inline: true },
    )
    .setColor(isLive ? 0x2ECC71 : 0x242429)
    .setFooter({ text: `Northstar Utils [v${BOT_VERSION}]` })
    .setTimestamp();
}

function buildStartupEmbed(readyClient) {
  return new EmbedBuilder()
    .setTitle('\ud83d\udfe2 Northstar Utils Online')
    .setDescription('All systems operational. Northstar Utils has been powered on and is now on standby.')
    .addFields(
      { name: 'Version', value: `v${BOT_VERSION}`, inline: true },
      { name: 'Logged In As', value: `${readyClient.user.tag}`, inline: true },
      { name: 'Started', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
    )
    .setColor(0x2ECC71)
    .setFooter({ text: `Northstar Utils [v${BOT_VERSION}]` })
    .setTimestamp();
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === 'ping') {
      await interaction.reply('Pong!');
      return;
    }

    if (interaction.commandName === 'patchnotes') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: 'You need administrator permissions to use this command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const patchnotesEmbed = new EmbedBuilder()
        .setTitle('Northstar Utils Patch Notes')
        .setDescription(`Latest feature updates for Northstar Utils v${BOT_VERSION} \u2013 workflow, automation and structuring update.`)
        .addFields(
          {
            name: 'Version',
            value: `Northstar Utils v${BOT_VERSION}`,
          },
          {
            name: '/project command (NEW)',
            value: `Creates a builder/project ticket in the projects category. Takes a project name, episode/chapter and build manager (required) plus an optional deadline, director (defaults to you) and budget. Only ${roleMention(PROJECT_ROLE_ID)} holders and administrators can run it. The ticket is private to the build manager, the director, anyone added with \`/padd\` and administrators, and it opens with a "Project Details" embed.`,
          },
          {
            name: '/padd command (NEW)',
            value: 'Run inside a project ticket to grant a user full chat access to that ticket (view, send, attach files, embed links, react).',
          },
          {
            name: '/event command (NEW)',
            value: 'Announces a recording event with an @everyone ping: time till event (Discord relative timestamp), IP, version and the amount of players needed. When the timer runs out the bot automatically posts a second `RECORDING EVENT LIVE` announcement. The `test` option sends both messages without pinging anyone.',
          },
          {
            name: '/accept overhaul',
            value: `Acceptance messages are now sent as an embed in the applicant's DMs instead of being posted in the ticket, with no Discord invite. The role is still granted, ${channelMention(ACCEPTED_QUESTIONS_CHANNEL_ID)} is used as a fallback when DMs are closed, and the ticket is closed automatically afterwards.`,
          },
          {
            name: 'Project creation logging',
            value: `Every project ticket creation is now logged to ${channelMention(BAN_REPORT_CHANNEL_ID)} alongside the existing ban reports.`,
          },
          {
            name: 'Spam-web auto-ban logging',
            value: `Automatic soft-bans from the spam trap channel now post the same action report as \`/ban\` to ${channelMention(BAN_REPORT_CHANNEL_ID)} with the reason "${ANTI_SPAM_BAN_REASON}".`,
          },
          {
            name: 'Start-up announcement',
            value: `The bot now posts a \ud83d\udfe2 "Northstar Utils Online" embed in ${channelMention(STARTUP_CHANNEL_ID)} every time it powers on.`,
          },
          {
            name: 'Updated trigger channels',
            value: `The "how join" trigger now points to ${channelMention(HOW_JOIN_CHANNEL_ID)} and the "how apply" trigger to ${channelMention(HOW_APPLY_CHANNEL_ID)}.`,
          },
          {
            name: '/close fix',
            value: 'The command now acknowledges the interaction and still deletes the ticket when the closure DM cannot be delivered.',
          },
        )
        .setFooter({ text: 'Developed by EXILED with CODEV GitHub Copilot.' })
        .setColor(0x242429);

      await interaction.reply({ embeds: [patchnotesEmbed], allowedMentions: { parse: [] } });
      return;
    }

    if (interaction.commandName === 'membercount') {
      if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used inside a server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply();

      const totalMembers = interaction.guild.memberCount;
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;

      try {
        const members = await interaction.guild.members.fetch();
        const joinedInPast24Hours = members.filter(
          (member) => !member.user.bot && member.joinedTimestamp && member.joinedTimestamp >= cutoff,
        ).size;

        await interaction.editReply(
          `Total member count: **${totalMembers}**\nJoined in the past 24 hours: **${joinedInPast24Hours}**`,
        );
      } catch (error) {
        console.error('Failed to fetch guild members for /membercount:', error);
        await interaction.editReply(
          `Total member count: **${totalMembers}**\nJoined in the past 24 hours: **Unavailable**`,
        );
      }
      return;
    }

    if (interaction.commandName === 'ticketstats') {
      if (!isAuthorized(interaction)) {
        await interaction.reply({
          content: 'You need administrator permissions to use this command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used inside a server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const { counts, total } = getOpenTicketStats(interaction.guild);
      const ticketStatsEmbed = new EmbedBuilder()
        .setTitle('Northstar Utils Ticket Statistics')
        .setDescription('Current open tickets by type')
        .addFields(
          ...TICKET_STATS_TYPES.map((type) => ({
            name: `${type.label} Tickets`,
            value: `${counts[type.key]}`,
            inline: true,
          })),
          {
            name: 'Total Open Tickets',
            value: `${total}`,
            inline: false,
          },
        )
        .setColor(0x242429);

      await interaction.reply({ embeds: [ticketStatsEmbed] });
      return;
    }

    if (interaction.commandName === 'project') {
      if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used inside a server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!(await hasProjectRole(interaction))) {
        await interaction.reply({
          content: `You need the ${roleMention(PROJECT_ROLE_ID)} role to use this command.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }

      const projectName = interaction.options.getString('name', true).trim();
      const episode = interaction.options.getString('episode', true).trim();
      const buildManager = interaction.options.getUser('build_manager', true);
      const director = interaction.options.getUser('director') ?? interaction.user;
      const deadline = interaction.options.getString('deadline')?.trim() || null;
      const budget = interaction.options.getString('budget')?.trim() || null;

      if (!projectName) {
        await interaction.reply({
          content: 'The project name cannot be empty.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let projectCategory = interaction.guild.channels.cache.get(PROJECT_CATEGORY_ID) ?? null;
      if (!projectCategory) {
        projectCategory = await interaction.guild.channels.fetch(PROJECT_CATEGORY_ID).catch(() => null);
      }

      if (!projectCategory || projectCategory.type !== ChannelType.GuildCategory) {
        await interaction.editReply('Could not find the project category. Check the configured category ID.');
        return;
      }

      const permissionOverwrites = [
        {
          id: interaction.guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        ...[...new Set([buildManager.id, director.id])].map((memberId) => ({
          id: memberId,
          allow: PROJECT_MEMBER_PERMISSIONS,
        })),
      ];

      if (client.user?.id) {
        permissionOverwrites.push({
          id: client.user.id,
          allow: [
            ...PROJECT_MEMBER_PERMISSIONS,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageRoles,
          ],
        });
      }

      let projectChannel = null;
      try {
        projectChannel = await interaction.guild.channels.create({
          name: getUniqueProjectChannelName(interaction.guild, projectName),
          type: ChannelType.GuildText,
          parent: projectCategory.id,
          topic: `${PROJECT_TOPIC_PREFIX}director:${director.id}:manager:${buildManager.id}`,
          permissionOverwrites,
          reason: `Project ticket "${projectName}" created by ${interaction.user.tag}`,
        });
      } catch (error) {
        console.error('Failed to create project channel:', error);
        await interaction.editReply('Failed to create the project channel. Check my permissions and the category ID.');
        return;
      }

      const projectDetailFields = [
        { name: 'Deadline', value: truncateForEmbed(deadline || 'Not specified.', 1024), inline: true },
        { name: 'Episode / Chapter', value: truncateForEmbed(episode, 1024), inline: true },
        { name: 'Project Build Manager', value: `<@${buildManager.id}>`, inline: true },
        { name: 'Project Director', value: `<@${director.id}>`, inline: true },
      ];

      if (budget) {
        projectDetailFields.push({ name: 'Project Budget', value: truncateForEmbed(budget, 1024), inline: true });
      }

      const projectEmbed = new EmbedBuilder()
        .setTitle(`${projectName} \u2013 Project Details`.slice(0, 256))
        .setDescription('A new Island Realm project ticket has been opened. Use `/padd` to give someone access to this ticket.')
        .addFields(...projectDetailFields)
        .setColor(0x242429)
        .setFooter({ text: `Created by ${interaction.user.tag}` })
        .setTimestamp();

      try {
        await projectChannel.send({
          content: `<@${director.id}> <@${buildManager.id}>`,
          embeds: [projectEmbed],
          allowedMentions: { users: [...new Set([director.id, buildManager.id])] },
        });
      } catch (error) {
        console.error('Failed to send project details embed:', error);
      }

      const projectLogEmbed = new EmbedBuilder()
        .setTitle('Action Report - Project Ticket Created')
        .setDescription(truncateForEmbed(
          [
            `**Project Name:** ${projectName}`,
            `**Channel:** ${projectChannel} (${projectChannel.id})`,
            `**Created By:** <@${interaction.user.id}> (${interaction.user.id})`,
            `**Project Build Manager:** <@${buildManager.id}> (${buildManager.id})`,
            `**Project Director:** <@${director.id}> (${director.id})`,
            '',
            '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
            `**Episode / Chapter:** ${episode}`,
            `**Deadline:** ${deadline || 'Not specified.'}`,
            `**Budget:** ${budget || 'Not specified.'}`,
          ].join('\n'),
          4096,
        ))
        .setColor(0x242429)
        .setTimestamp();

      await sendAlertChannelEmbed(interaction.guild, projectLogEmbed);

      await interaction.editReply(`Project ticket created: ${projectChannel}`);
      return;
    }

    if (interaction.commandName === 'padd') {
      if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used inside a server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!isProjectChannel(interaction.channel)) {
        await interaction.reply({
          content: 'This command can only be used inside a project (builder) ticket channel.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!(await hasProjectRole(interaction))) {
        await interaction.reply({
          content: `You need the ${roleMention(PROJECT_ROLE_ID)} role to use this command.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }

      const targetUser = interaction.options.getUser('user', true);

      await interaction.deferReply();

      let targetMember = null;
      try {
        targetMember = await interaction.guild.members.fetch(targetUser.id);
      } catch (error) {
        console.error('Failed to fetch member for /padd:', error);
        await interaction.editReply('That user is not a member of this server.');
        return;
      }

      try {
        await interaction.channel.permissionOverwrites.edit(
          targetMember.id,
          PROJECT_MEMBER_PERMISSION_OVERWRITE,
          { reason: `Added to project ticket by ${interaction.user.tag}` },
        );
      } catch (error) {
        console.error('Failed to add member to project ticket:', error);
        await interaction.editReply('Failed to add that user to this ticket. Check my permissions.');
        return;
      }

      await interaction.editReply(`Added <@${targetMember.id}> to this project ticket.`);
      return;
    }

    if (interaction.commandName === 'event') {
      if (!isAuthorized(interaction)) {
        await interaction.reply({
          content: 'You need administrator permissions to use this command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used inside a server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const timeInput = interaction.options.getString('time', true);
      const eventIp = interaction.options.getString('ip', true).trim();
      const eventVersion = interaction.options.getString('version', true);
      const playersNeeded = interaction.options.getInteger('players', true);
      const isTest = interaction.options.getBoolean('test') ?? false;
      const delayMs = parseTimeUntilEvent(timeInput);

      if (delayMs === null) {
        await interaction.reply({
          content: 'Could not read that time. Use a format like `30m`, `2h`, `1h30m`, or a plain number of minutes.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (delayMs > EVENT_MAX_DELAY_MS) {
        await interaction.reply({
          content: `The event has to start within ${formatDurationLabel(EVENT_MAX_DELAY_MS)}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const startTimestampSeconds = Math.floor((Date.now() + delayMs) / 1000);
      const announcementChannel = interaction.channel;

      if (!announcementChannel?.isTextBased()) {
        await interaction.reply({
          content: 'I cannot send the announcement in this channel.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const buildEventPayload = (isLive) => {
        const payload = {
          embeds: [
            buildEventEmbed({
              isLive,
              startTimestampSeconds,
              ip: eventIp,
              version: eventVersion,
              players: playersNeeded,
            }),
          ],
          allowedMentions: isTest ? { parse: [] } : { parse: ['everyone'] },
        };

        if (!isTest) {
          payload.content = '@everyone';
        }

        return payload;
      };

      try {
        await announcementChannel.send(buildEventPayload(false));
      } catch (error) {
        console.error('Failed to send recording event announcement:', error);
        await interaction.editReply('Failed to send the event announcement. Check my permissions in this channel.');
        return;
      }

      const announcementChannelId = interaction.channelId;
      setTimeout(async () => {
        try {
          const liveChannel = await client.channels.fetch(announcementChannelId);
          if (!liveChannel?.isTextBased()) {
            return;
          }

          await liveChannel.send(buildEventPayload(true));
        } catch (error) {
          console.error('Failed to send recording event live announcement:', error);
        }
      }, delayMs);

      await interaction.editReply(
        `Recording event announced${isTest ? ' (test mode, no pings)' : ''}. The live announcement goes out in ${formatDurationLabel(delayMs)}.`,
      );
      return;
    }

    if (interaction.commandName === 'ban') {
      if (!isAuthorized(interaction)) {
        await interaction.reply({
          content: 'You need administrator permissions to use this command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used inside a server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const userInput = interaction.options.getString('user', true);
      const reason = interaction.options.getString('reason', true).trim();
      const durationValue = interaction.options.getString('duration', true);
      const shouldDeleteMessages = interaction.options.getBoolean('delete_messages', true);
      const banDuration = BAN_DURATION_OPTIONS[durationValue];
      const userIdToBan = parseUserIdFromInput(userInput);

      if (!banDuration || !userIdToBan) {
        await interaction.reply({
          content: 'Invalid ban input. Use a valid user mention/ID and duration.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (userIdToBan === interaction.user.id) {
        await interaction.reply({
          content: 'You cannot ban yourself.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (userIdToBan === client.user.id) {
        await interaction.reply({
          content: 'I cannot ban myself.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let userToBan = null;
      try {
        userToBan = await client.users.fetch(userIdToBan);
      } catch (error) {
        await interaction.editReply('Could not resolve that user. Please provide a valid mention or user ID.');
        return;
      }

      const banId = generateBanId();
      const banTag = `BANID-${banId}`;
      const appealText = `If you believe our decision was wrong and wish to appeal, contact \`support@northstarmedia.cc\` with your Ban ID: ${banTag}`;
      const dmEmbed = new EmbedBuilder()
        .setTitle('You have been banned from __Island Realm__.')
        .setDescription(`${reason}\n\nLength of Ban: **${banDuration.label}**\n\n${appealText}`)
        .setColor(0xFF0000)
        .setFooter({ text: banTag });

      try {
        await userToBan.send({ embeds: [dmEmbed] });
      } catch (error) {
        console.error('Failed to send pre-ban DM:', error);
      }

      const deleteMessageSeconds = shouldDeleteMessages ? 7 * 24 * 60 * 60 : 0;
      const banAuditReason = `${reason} (${banTag})`;

      try {
        await interaction.guild.members.ban(userIdToBan, {
          reason: banAuditReason,
          deleteMessageSeconds,
        });
      } catch (error) {
        console.error('Failed to execute /ban command:', error);
        await interaction.editReply('Failed to ban the user. Check my permissions and role hierarchy.');
        return;
      }

      if (banDuration.ms) {
        setTimeout(async () => {
          try {
            await interaction.guild.bans.remove(
              userIdToBan,
              `Temporary ban expired (${banDuration.label}) ${banTag}.`,
            );
          } catch (error) {
            console.error('Failed to auto-unban temporarily banned user:', error);
          }
        }, banDuration.ms);
      }

      const banReportEmbed = buildBanReportEmbed({
        inputUserArgument: userInput,
        durationLabel: banDuration.label,
        deleteMessages: shouldDeleteMessages,
        userId: userIdToBan,
        reason,
        banTag,
      });

      await sendAlertChannelEmbed(interaction.guild, banReportEmbed);

      await interaction.editReply(`Ban executed for **${userToBan.tag}** (${userIdToBan}). Ban ID: ${banTag}`);
      return;
    }
  }

  if (interaction.isButton() && interaction.customId === APPLY_BUTTON_ID) {
    const modal = new ModalBuilder()
      .setCustomId(APPLY_MODAL_ID)
      .setTitle('Actor Application');

    const nameInput = new TextInputBuilder()
      .setCustomId('applicant_name')
      .setLabel('What is your name?')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(50);

    const ageInput = new TextInputBuilder()
      .setCustomId('applicant_age')
      .setLabel('How old are you?')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(2);

    const whyInput = new TextInputBuilder()
      .setCustomId('applicant_reason')
      .setLabel('Why do you want to be an actor?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(500);

    const expInput = new TextInputBuilder()
        .setCustomId('applicant_exp')
        .setLabel('Acting experience (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500);


    modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(ageInput),
        new ActionRowBuilder().addComponents(whyInput),
        new ActionRowBuilder().addComponents(expInput),
    );

    await interaction.showModal(modal);
    return;
  }

  if (interaction.isButton() && interaction.customId === BUILDER_BUTTON_ID) {
    const modal = new ModalBuilder()
        .setCustomId(BUILDER_MODAL_ID)
        .setTitle('Builder Application');

    const nameInput = new TextInputBuilder()
        .setCustomId('applicant_name')
        .setLabel('What is your name?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50);

    const ageInput = new TextInputBuilder()
        .setCustomId('applicant_age')
        .setLabel('How old are you?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(2);

    const lengthInput = new TextInputBuilder()
        .setCustomId('applicant_length')
        .setLabel('How long have you been building in Minecraft?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(500);

    const expInput = new TextInputBuilder()
        .setCustomId('applicant_exp')
        .setLabel('Building experience (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500);


    modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(ageInput),
        new ActionRowBuilder().addComponents(lengthInput),
        new ActionRowBuilder().addComponents(expInput),
    );

    await interaction.showModal(modal);
    return;
  }

  if (interaction.isButton() && interaction.customId === STAFF_BUTTON_ID) {
    const modal = new ModalBuilder()
        .setCustomId(STAFF_MODAL_ID)
        .setTitle('Staff Application');

    const nameInput = new TextInputBuilder()
        .setCustomId('applicant_name')
        .setLabel('What is your name?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50);

    const ageInput = new TextInputBuilder()
        .setCustomId('applicant_age')
        .setLabel('How old are you?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(2);

    const reasonInput = new TextInputBuilder()
        .setCustomId('applicant_reason')
        .setLabel('Why do you want to become staff?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500);

    const expInput = new TextInputBuilder()
        .setCustomId('applicant_exp')
        .setLabel('Experience')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500);

    modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(ageInput),
        new ActionRowBuilder().addComponents(reasonInput),
        new ActionRowBuilder().addComponents(expInput),
    );

    await interaction.showModal(modal);
    return;
  }

  if (interaction.isButton() && interaction.customId === TEAM_BUTTON_ID) {
    const modal = new ModalBuilder()
        .setCustomId(TEAM_MODAL_ID)
        .setTitle('Team Application');

    const nameInput = new TextInputBuilder()
        .setCustomId('applicant_name')
        .setLabel('What is your name?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50);

    const ageInput = new TextInputBuilder()
        .setCustomId('applicant_age')
        .setLabel('How old are you?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(2);

    const positionInput = new TextInputBuilder()
        .setCustomId('applicant_position')
        .setLabel('Position (Developer/Scriptwriter/etc.)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

    const reasonInput = new TextInputBuilder()
        .setCustomId('applicant_reason')
        .setLabel('Why do you want to join Northstar?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500);

    const expInput = new TextInputBuilder()
        .setCustomId('applicant_exp')
        .setLabel('Experience')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500);

    modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(ageInput),
        new ActionRowBuilder().addComponents(positionInput),
        new ActionRowBuilder().addComponents(reasonInput),
        new ActionRowBuilder().addComponents(expInput),
    );

    await interaction.showModal(modal);
    return;
  }

  if (interaction.isButton() && interaction.customId === SUPPORT_BUTTON_ID) {
    const modal = new ModalBuilder()
        .setCustomId(SUPPORT_MODAL_ID)
        .setTitle('Support Ticket');

    const nameInput = new TextInputBuilder()
        .setCustomId('applicant_name')
        .setLabel('What is your name?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50);

    const subjectInput = new TextInputBuilder()
        .setCustomId('ticket_subject')
        .setLabel('What is the subject of your issue?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500);

    modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(subjectInput),
    );

    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === APPLY_MODAL_ID) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'This form can only be submitted inside a server.',
      });
      return;
    }

    const name = interaction.fields.getTextInputValue('applicant_name').trim();
    const age = interaction.fields.getTextInputValue('applicant_age').trim();
    const reason = interaction.fields.getTextInputValue('applicant_reason').trim();
    const exp = interaction.fields.getTextInputValue('applicant_exp').trim();

    const existingChannel = findExistingActorApplicationChannel(interaction.guild, interaction.user.id);
    if (existingChannel) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `You already have an open actor application channel: ${existingChannel}`,
      });
      return;
    }

    const usernamePart = sanitizeChannelPart(interaction.user.username).slice(0, 94);
    const channelName = getUniqueActorChannelName(interaction.guild, usernamePart);

    try {
      const applicationChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `${ACTOR_TOPIC_PREFIX}${interaction.user.id}:status:open`,
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks,
            ],
          },
        ],
        reason: `Actor application submitted by ${interaction.user.tag}`,
      });

      const appEmbed = new EmbedBuilder()
          .setTitle('Actor Application')
          .setDescription(`Application submitted by <@${interaction.user.id}>`)
          .addFields(
              {name:"Name", value:`${name}`},
              {name:"Age", value:`${age}`},
              {name:"Reason", value:`${reason}`},
              {name:"Experience", value:`${exp || 'Not provided.'}`}
          )
          .setFooter(
              {text:"Please do not ping anyone until we review your application."}
          )
          .setColor(0xFF0000);

      const actEmbed = new EmbedBuilder()
          .setTitle('Acting Test')
          .setDescription("(ANGRY) YOU PROMISED YOU'D STAY BY MY SIDE TILL THE END! AND NOW... LOOK WHAT YOU'VE DONE.\n\n" +
              "(DISAPPOINTED/SAD) Listen... if you really wish to kill me, then go ahead. All I ever wanted was to help this server..\n\n" +
              "(BAFFLED/EVIL TONE) *small laugh* You think you can stop ME? You and what army, exactly? You are a NOBODY.\n\n" +
              "(INTRIGUED/NEUTRAL) Huh, you seem different from the others. I like that. Maybe you have potential after all. Prove it to me, and maybe I'll let you stay.")
          .setColor(0x242429)
          .setFooter(
              {text:"Please do your best in acting while saying these lines. It is the most important part of your application."}
          );

      await applicationChannel.send(
            {content:`${roleMention(ADMIN_ROLE_ID)}`, embeds: [appEmbed] }
      );
      await applicationChannel.send(
          {content:`Hey there <@${interaction.user.id}>!\n\nThanks for applying to become an Actor in our series!\n\n` +
                `In order to proceed with your application, please submit an audio file with you saying the following lines:\n`, embeds: [actEmbed] }
      )
      // await applicationChannel.send(
      //     {embeds: [actEmbed]}
      // )

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `Thanks for applying, ${name}! I created ${applicationChannel} for your application.`,
      });
    } catch (error) {
      console.error('Failed to create actor application channel:', error);
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'Your form was received, but I could not create the channel. Check my channel permissions.',
      });
    }
  }

  // BUILDER LOGIC
  if (interaction.isModalSubmit() && interaction.customId === BUILDER_MODAL_ID) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'This form can only be submitted inside a server.',
      });
      return;
    }

    const name = interaction.fields.getTextInputValue('applicant_name').trim();
    const age = interaction.fields.getTextInputValue('applicant_age').trim();
    const reason = interaction.fields.getTextInputValue('applicant_length').trim();
    const exp = interaction.fields.getTextInputValue('applicant_exp').trim();

    const existingChannel = findExistingBuilderApplicationChannel(interaction.guild, interaction.user.id);
    if (existingChannel) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `You already have an open actor application channel: ${existingChannel}`,
      });
      return;
    }

    const usernamePart = sanitizeChannelPart(interaction.user.username).slice(0, 94);
    const channelName = getUniqueBuilderChannelName(interaction.guild, usernamePart);

    try {
      const applicationChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `${BUILDER_TOPIC_PREFIX}${interaction.user.id}:status:open`,
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks,
            ],
          },
        ],
        reason: `Builder application submitted by ${interaction.user.tag}`,
      });

      const appEmbed = new EmbedBuilder()
          .setTitle('Builder Application')
          .setDescription(`Application submitted by <@${interaction.user.id}>`)
          .addFields(
              {name:"Name", value:`${name}`},
              {name:"Age", value:`${age}`},
              {name:"Building experience", value:`${reason}`},
              {name:"Previous experience", value:`${exp || 'Not provided.'}`}
          )
          .setFooter(
              {text:"Please do not ping anyone until we review your application."}
          )
          .setColor(0xFF0000);

      await applicationChannel.send(
          {content:`${roleMention(ADMIN_ROLE_ID)}`, embeds: [appEmbed] }
      );
      await applicationChannel.send(
          {content:`Hey there <@${interaction.user.id}>!\n\nThanks for applying to become a Builder in our series!\n\n` +
                `In order to proceed with your application, please submit a couple of images with your past builds.\n\n⚠️ **Please note that if any of the images submitted are stolen and not yours, you will be banned.**`}
      )
      // await applicationChannel.send(
      //     {embeds: [actEmbed]}
      // )

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `Thanks for applying, ${name}! I created ${applicationChannel} for your application.`,
      });
    } catch (error) {
      console.error('Failed to create builder application channel:', error);
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'Your form was received, but I could not create the channel. Check my channel permissions.',
      });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === STAFF_MODAL_ID) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'This form can only be submitted inside a server.',
      });
      return;
    }

    const name = interaction.fields.getTextInputValue('applicant_name').trim();
    const age = interaction.fields.getTextInputValue('applicant_age').trim();
    const reason = interaction.fields.getTextInputValue('applicant_reason').trim();
    const exp = interaction.fields.getTextInputValue('applicant_exp').trim();

    const existingChannel = findExistingStaffApplicationChannel(interaction.guild, interaction.user.id);
    if (existingChannel) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `You already have an open staff application channel: ${existingChannel}`,
      });
      return;
    }

    const usernamePart = sanitizeChannelPart(interaction.user.username).slice(0, 94);
    const channelName = getUniqueStaffChannelName(interaction.guild, usernamePart);

    try {
      const applicationChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `${STAFF_TOPIC_PREFIX}${interaction.user.id}:status:open`,
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks,
            ],
          },
        ],
        reason: `Staff application submitted by ${interaction.user.tag}`,
      });

      const appEmbed = new EmbedBuilder()
          .setTitle('Staff Application')
          .setDescription(`Application submitted by <@${interaction.user.id}>`)
          .addFields(
              { name: 'Name', value: `${name}` },
              { name: 'Age', value: `${age}` },
              { name: 'Reason', value: `${reason}` },
              { name: 'Experience', value: `${exp}` },
          )
          .setFooter(
              { text: 'Please do not ping anyone until we review your application.' },
          )
          .setColor(0xFF0000);

      await applicationChannel.send(
          { content: `${roleMention(ADMIN_ROLE_ID)}`, embeds: [appEmbed] },
      );
      await applicationChannel.send(
          { content: `<@${interaction.user.id}> Please tell us about yourself` },
      );

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `Thanks for applying, ${name}! I created ${applicationChannel} for your application.`,
      });
    } catch (error) {
      console.error('Failed to create staff application channel:', error);
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'Your form was received, but I could not create the channel. Check my channel permissions.',
      });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === TEAM_MODAL_ID) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'This form can only be submitted inside a server.',
      });
      return;
    }

    const name = interaction.fields.getTextInputValue('applicant_name').trim();
    const age = interaction.fields.getTextInputValue('applicant_age').trim();
    const position = interaction.fields.getTextInputValue('applicant_position').trim();
    const reason = interaction.fields.getTextInputValue('applicant_reason').trim();
    const exp = interaction.fields.getTextInputValue('applicant_exp').trim();

    const existingChannel = findExistingTeamApplicationChannel(interaction.guild, interaction.user.id);
    if (existingChannel) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `You already have an open team application channel: ${existingChannel}`,
      });
      return;
    }

    const usernamePart = sanitizeChannelPart(interaction.user.username).slice(0, 94);
    const channelName = getUniqueTeamChannelName(interaction.guild, usernamePart);

    try {
      const applicationChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `${TEAM_TOPIC_PREFIX}${interaction.user.id}:status:open`,
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks,
            ],
          },
        ],
        reason: `Team application submitted by ${interaction.user.tag}`,
      });

      const appEmbed = new EmbedBuilder()
          .setTitle('Team Application')
          .setDescription(`Application submitted by <@${interaction.user.id}>`)
          .addFields(
              { name: 'Name', value: `${name}` },
              { name: 'Age', value: `${age}` },
              { name: 'Position', value: `${position}` },
              { name: 'Reason', value: `${reason}` },
              { name: 'Experience', value: `${exp}` },
          )
          .setFooter(
              { text: 'Please do not ping anyone until we review your application.' },
          )
          .setColor(0xFF0000);

      await applicationChannel.send(
          { content: `${roleMention(ADMIN_ROLE_ID)}`, embeds: [appEmbed] },
      );
      await applicationChannel.send(
          { content: `<@${interaction.user.id}> Please describe what makes you better than other candidates and elaborate on your experience in the domain you are applying for` },
      );

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `Thanks for applying, ${name}! I created ${applicationChannel} for your application.`,
      });
    } catch (error) {
      console.error('Failed to create team application channel:', error);
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'Your form was received, but I could not create the channel. Check my channel permissions.',
      });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === SUPPORT_MODAL_ID) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'This form can only be submitted inside a server.',
      });
      return;
    }

    const name = interaction.fields.getTextInputValue('applicant_name').trim();
    const subject = interaction.fields.getTextInputValue('ticket_subject').trim();

    const existingChannel = findExistingSupportTicketChannel(interaction.guild, interaction.user.id);
    if (existingChannel) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `You already have an open support ticket channel: ${existingChannel}`,
      });
      return;
    }

    const usernamePart = sanitizeChannelPart(interaction.user.username).slice(0, 94);
    const channelName = getUniqueSupportChannelName(interaction.guild, usernamePart);

    try {
      const ticketChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `${SUPPORT_TOPIC_PREFIX}${interaction.user.id}:status:open`,
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks,
            ],
          },
        ],
        reason: `Support ticket submitted by ${interaction.user.tag}`,
      });

      const supportEmbed = new EmbedBuilder()
          .setTitle('Support Ticket')
          .setDescription(`Ticket submitted by <@${interaction.user.id}>`)
          .addFields(
              { name: 'Name', value: `${name}` },
              { name: 'Subject', value: `${subject}` },
          )
          .setFooter(
              { text: 'Please do not ping anyone until we review your ticket.' },
          )
          .setColor(0xFF0000);

      await ticketChannel.send(
          { content: `${roleMention(ADMIN_ROLE_ID)}`, embeds: [supportEmbed] },
      );
      await ticketChannel.send(
          { content: `<@${interaction.user.id}> Please describe your issue - DO NOT PING THE ADMINS - they will handle your ticket as soon as they are available` },
      );

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `Thanks, ${name}! I created ${ticketChannel} for your support ticket.`,
      });
    } catch (error) {
      console.error('Failed to create support ticket channel:', error);
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'Your form was received, but I could not create the channel. Check my channel permissions.',
      });
    }
  }
  if(interaction.isChatInputCommand() && interaction.commandName === 'accept') {
    if (!isAuthorized(interaction)) {
      return;
    }

    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: 'This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const applicantId = getApplicantIdFromChannel(interaction.channel);

    if (!applicantId) {
      await interaction.reply({
        content: 'Could not find applicant ID. Make sure this command is run in an actor or builder application channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const isActorChannel = interaction.channel.topic?.startsWith(ACTOR_TOPIC_PREFIX);
    const isBuilderChannel = interaction.channel.topic?.startsWith(BUILDER_TOPIC_PREFIX);

    if (!isActorChannel && !isBuilderChannel) {
      await interaction.reply({
        content: 'This command can only be used in actor or builder application channels.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const roleId = isActorChannel ? ACTOR_ROLE_ID : BUILDER_ROLE_ID;
    const programLabel = isActorChannel ? 'Actor' : 'Builder';
    const role = interaction.guild.roles.cache.get(roleId);

    if (!role) {
      await interaction.reply({
        content: 'Role not found. Check the role ID.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let applicantMember = null;
    try {
      applicantMember = await interaction.guild.members.fetch(applicantId);
    } catch (error) {
      console.error('Failed to fetch applicant for /accept:', error);
      await interaction.editReply('Could not find the applicant in this server.');
      return;
    }

    try {
      await applicantMember.roles.add(role);
    } catch (error) {
      console.error('Failed to add role:', error);
      await interaction.editReply('Failed to add role. Check my permissions.');
      return;
    }

    const acceptanceEmbed = buildAcceptanceEmbed(applicantId, programLabel);
    let deliveryNote = '';

    try {
      await applicantMember.send({ embeds: [acceptanceEmbed] });
      deliveryNote = 'Acceptance message sent via DM.';
    } catch (dmError) {
      console.error('Failed to DM acceptance message to applicant:', dmError);

      const fallbackChannel = await resolveGuildTextChannel(interaction.guild, ACCEPTED_QUESTIONS_CHANNEL_ID);
      if (fallbackChannel) {
        try {
          await fallbackChannel.send({ embeds: [acceptanceEmbed] });
          deliveryNote = `DMs are closed, so the acceptance message was posted in ${channelMention(ACCEPTED_QUESTIONS_CHANNEL_ID)}.`;
        } catch (fallbackError) {
          console.error('Failed to post acceptance message in fallback channel:', fallbackError);
          deliveryNote = 'Could not DM the applicant and the fallback channel post failed.';
        }
      } else {
        deliveryNote = 'Could not DM the applicant and the fallback channel could not be resolved.';
      }
    }

    await interaction.editReply(
      `Accepted <@${applicantId}> for the ${programLabel} program and granted the ${role.name} role. ${deliveryNote} Closing this ticket now.`,
    );

    // The acceptance message above is the applicant's notification, so close the
    // channel without the extra "your ticket has been closed" DM /close sends.
    await closeTicketChannel(interaction.guild, interaction.channelId, null);
    return;
  }
  if(interaction.isChatInputCommand() && interaction.commandName === 'reject') {
    if (!isAuthorized(interaction)) {
      return;
    }
    const applicantId = getApplicantIdFromChannel(interaction.channel);
    if (!applicantId) {
      await interaction.reply('Could not find applicant ID. Make sure this command is run in an actor or builder application channel.');
      return;
    }

    const isActorChannel = interaction.channel.topic?.startsWith(ACTOR_TOPIC_PREFIX);
    const isBuilderChannel = interaction.channel.topic?.startsWith(BUILDER_TOPIC_PREFIX);

    if (!isActorChannel && !isBuilderChannel) {
      await interaction.reply('This command can only be used in actor or builder application channels.');
      return;
    }

    try {
      const applicantMember = await interaction.guild.members.fetch(applicantId);
      const dmChannel = await applicantMember.createDM();
      const roleType = isActorChannel ? 'Actor' : 'Builder';
      await dmChannel.send(`Your ${roleType} application in Island SMP has been rejected. Thank you for your interest!`);
    } catch (error) {
      console.error('Failed to send DM to applicant:', error);
    }

    await interaction.guild.channels.delete(interaction.channelId);
  }
  if(interaction.isChatInputCommand() && interaction.commandName === 'close') {
    if (!isAuthorized(interaction)) {
      return;
    }
    const applicantId = getApplicantIdFromChannel(interaction.channel);
    if (!applicantId) {
      await interaction.reply({
        content: 'Could not find applicant ID. Make sure this command is run in an application or support ticket channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: 'Closing this ticket now.',
      flags: MessageFlags.Ephemeral,
    });

    await closeTicketChannel(interaction.guild, interaction.channelId, applicantId);
    return;
  }

  if(interaction.isChatInputCommand() && interaction.commandName === 'faq') {
    const embed = new EmbedBuilder()
        .setTitle('FAQ')
        .setDescription('Frequently Asked Questions')
        .addFields(
            { name:"Can I join on Bedrock?", value:"No, this server is Java Edition only."},
            { name:"Can cracked users join?", value:"No, this server is premium and we follow the Mojang EULA."},
            { name:"How do I apply?", value:`${channelMention('1156739680994328616')} is where you can apply to become an actor in our series! Just click the button there and fill out the form to start your application.`},
            { name:"What happens after I apply?", value:"After you submit your application, a new channel will be created for you where you will be asked to submit an acting test. Our team will review your application and acting test, and if you are accepted, you will receive a role that gives you access to the actor channels and updates about the series. Do note that being accepted can take up to a day or two, depending on how our managers are."},
            { name:"What is the IP?", value:"This is not a public SMP. There is no IP to join, and you cannot play whenever you'd like. You can only play when we host recording events in order to contribute to our storyline. For more information, do /faq in #faq."}
        )
        .setColor(0x242429);

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral});
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  const welcomeMessage = `Hello ${member}! Welcome to the **Island Realm**! Please check your DMs for information regarding our server/series & how to join!`;
  const welcomeEmbed = buildWelcomeEmbed(member.user);

  const welcomeChannel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (welcomeChannel?.isTextBased()) {
    try {
      await welcomeChannel.send({ content: welcomeMessage });
    } catch (error) {
      console.error('Failed to send welcome message in channel:', error);
    }
  }

  try {
    await member.send({ embeds: [welcomeEmbed] });
  } catch (error) {
    console.error('Failed to send welcome DM to new member:', error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (isAntiSpamTrapChannel(message.channel)) {
    if (!message.inGuild() || !message.member) return;

    if (message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return;
    }

    const banTag = `BANID-${generateBanId()}`;

    try {
      await message.member.ban({
        reason: `${ANTI_SPAM_BAN_REASON} (${banTag})`,
        deleteMessageSeconds: ANTI_SPAM_DELETE_SECONDS,
      });

      setTimeout(async () => {
        try {
          await message.guild.bans.remove(
            message.author.id,
            `Antispam temporary ban expired after 7 days. (${banTag})`,
          );
        } catch (error) {
          console.error('Failed to auto-unban antispam trap user:', error);
        }
      }, ANTI_SPAM_BAN_DURATION_MS);

      await sendAlertChannelEmbed(
        message.guild,
        buildBanReportEmbed({
          inputUserArgument: `<@${message.author.id}>`,
          durationLabel: BAN_DURATION_OPTIONS['7d'].label,
          deleteMessages: true,
          userId: message.author.id,
          reason: ANTI_SPAM_BAN_REASON,
          banTag,
        }),
      );
    } catch (error) {
      console.error('Failed to ban antispam trap user:', error);
    }
    return;
  }

  const sayCommandMatch = message.content.match(/^~\$say(?:\s+([\s\S]+))?$/);

  if (message.author.id === ALLOWED_USER_ID && sayCommandMatch) {
    try {
      await message.delete();
    } catch (error) {
      console.error('Failed to delete ~$say command message:', error);
    }

    const sayMessage = sayCommandMatch[1]?.trim();
    if (sayMessage) {
      await message.channel.send({ content: sayMessage });
    }
    return;
  }

  const normalizedContent = message.content.trim().toLowerCase();

  if (message.author.id === ALLOWED_USER_ID && normalizedContent === '~$sendwelcome') {
    const targetUser = message.mentions.users.first() ?? message.author;
    const welcomeEmbed = buildWelcomeEmbed(targetUser);
    await message.channel.send({ embeds: [welcomeEmbed] });
    return;
  }

  if (message.mentions.users.has(client.user.id)) {
    if (message.author.id !== ALLOWED_USER_ID) return;

    try {
      const rawErrors = recentConsoleErrors.length === 0 ?
        'No recent console errors recorded.' :
        recentConsoleErrors.slice(-3).reverse().join('\n');
      const recentErrorsValue = rawErrors.length > 1024 ? `${rawErrors.slice(0, 1021)}...` : rawErrors;
      const uptimeValue = formatUptime(client.uptime ?? (process.uptime() * 1000));
      const statusEmbed = new EmbedBuilder()
        .setTitle('Northstar Utils Status Report')
        .setDescription('Online & Functional')
        .addFields(
          { name: 'Recent Console Errors', value: recentErrorsValue },
          { name: 'Uptime', value: uptimeValue },
        )
        .setColor(0x242429)
        .setFooter({ text: `Northstar Utils [v${BOT_VERSION}]` });

      await message.reply({ embeds: [statusEmbed] });
    } catch (error) {
      console.error('Failed to send status report embed on mention:', error);
    }
    return;
  }

  if (message.author.id === ALLOWED_USER_ID && normalizedContent === 'yo northstar utils make me sum to eat') {
    await message.reply('bro im a robot');
    return;
  }

  if (message.author.id === ALLOWED_USER_ID && normalizedContent === 'am i right northstar utils?') {
    const replies = [
      'Right just as always!',
      'Yep, correct. You are always right Exiled.',
    ];
    await message.reply(replies[Math.floor(Math.random() * replies.length)]);
    return;
  }

  if (message.content.trim().toLowerCase() === 'postappembed') {
    if (message.author.id !== ALLOWED_USER_ID) return;
    await message.delete();
    const embed = new EmbedBuilder()
        .setTitle('Actor Applications')
        .setDescription('Open a ticket to apply to become an Actor in our series.\n------------------------------------------------')
        .setColor(0x242429)
        .addFields(
            { name:"Requirements", value:"➡️ **Be at least 16 years old.**\n➡️ Have a microphone.\n➡️ Speak fluent english. "}
        )
        .setFooter(
            {text:"Click on the button below to begin your application!"}
        )

    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(APPLY_BUTTON_ID)
        .setLabel('Apply for Actor')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
          .setCustomId(BUILDER_BUTTON_ID)
          .setLabel('Apply for Builder')
          .setStyle(ButtonStyle.Secondary),
    );

    await message.channel.send({ embeds: [embed], components: [buttonRow] });
  }

  if (normalizedContent === 'poststaffteamembed') {
    if (message.author.id !== ALLOWED_USER_ID) return;
    await message.delete();

    const staffEmbed = new EmbedBuilder()
        .setTitle('Staff Applications')
        .setDescription('Become a staff member within the Island Realm community and help out with moderation.\n------------------------------------------------')
        .setColor(0x242429)
        .setFooter({ text: 'Click on the button below to begin your staff application!' });

    const teamEmbed = new EmbedBuilder()
        .setTitle('Team Applications')
        .setDescription('Apply to be a Developer / Scriptwriter / Composer / Marketing Agent / Event Manager.\n------------------------------------------------')
        .setColor(0x242429)
        .setFooter({ text: 'Click on the button below to begin your team application!' });

    const staffButtonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(STAFF_BUTTON_ID)
            .setLabel('Apply for Staff')
            .setStyle(ButtonStyle.Primary),
    );

    const teamButtonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(TEAM_BUTTON_ID)
            .setLabel('Apply for Team')
            .setStyle(ButtonStyle.Secondary),
    );

    await message.channel.send({ embeds: [staffEmbed], components: [staffButtonRow] });
    await message.channel.send({ embeds: [teamEmbed], components: [teamButtonRow] });
    return;
  }

  if (normalizedContent === 'postsupportembed') {
    if (message.author.id !== ALLOWED_USER_ID) return;
    await message.delete();

    const supportEmbed = new EmbedBuilder()
        .setTitle('Support Tickets')
        .setDescription('Open a support ticket if you need help from the team.\n------------------------------------------------')
        .setColor(0x242429)
        .setFooter({ text: 'Click on the button below to open a support ticket!' });

    const supportButtonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(SUPPORT_BUTTON_ID)
            .setLabel('Open Support Ticket')
            .setStyle(ButtonStyle.Danger),
    );

    await message.channel.send({ embeds: [supportEmbed], components: [supportButtonRow] });
    return;
  }

  if (normalizedContent === '~$init protocol 41') {
    if (message.author.id !== ALLOWED_USER_ID) return;

    try {
      await sendChatRevivePing(message.guild);
      await message.reply('Chat revive ping dispatched.');
    } catch (error) {
      console.error('Failed to dispatch manual chat revive ping:', error);
      await message.reply('Failed to dispatch chat revive ping.');
    }

    return;
  }

  if (normalizedContent === '~$init antispam') {
    if (message.author.id !== ALLOWED_USER_ID) return;

    if (!message.inGuild() || !message.guild) {
      await message.reply('This command can only be used inside a server.');
      return;
    }

    const existingTrapChannel = message.guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        channel.parentId === message.channel.parentId &&
        isAntiSpamTrapChannel(channel),
    );

    if (existingTrapChannel) {
      await message.reply(`An antispam trap channel already exists here: ${existingTrapChannel}`);
      return;
    }

    try {
      const trapChannel = await message.guild.channels.create({
        name: ANTI_SPAM_CHANNEL_NAME,
        type: ChannelType.GuildText,
        parent: message.channel.parentId ?? undefined,
        topic: ANTI_SPAM_TOPIC,
        reason: `Antispam trap channel initialized by ${message.author.tag}`,
      });

      const warningEmbed = new EmbedBuilder()
        .setTitle('WARNING')
        .setDescription(
          'This is a spam/scam bot web channel. It is a trap set for scam bots, and **if you send a message in this channel, you will be automatically banned.**',
        )
        .setColor(0xFF0000);

      await trapChannel.send({ embeds: [warningEmbed] });
      await message.reply(`Antispam trap channel created: ${trapChannel}`);
    } catch (error) {
      console.error('Failed to create antispam trap channel:', error);
      await message.reply('Failed to create antispam trap channel. Check my permissions.');
    }
    return;
  }

  if (message.content.includes("how") && message.content.includes("apply")) {
    await message.reply(
        {content:`${channelMention(HOW_APPLY_CHANNEL_ID)} is where you can apply to become an actor in our series! Just click the button there and fill out the form to start your application.`}
    );
  }
  if (message.content.includes("how") && message.content.includes("join")) {
    await message.reply(
        {content:`${channelMention(HOW_JOIN_CHANNEL_ID)} is where you can find information about how to participate in our series!` }
    );
  }

  if(message.content.trim().toLowerCase() === 'info') {
    if (message.author.id !== ALLOWED_USER_ID) return;
    const embed = new EmbedBuilder()
        .setTitle('📌 Information')
        .setDescription(`➡️ **What is Island SMP?**\nIsland SMP is a new scripted SMP content series which aims to bring cinematography and epicness to the Minecraft scene.\n\n➡️ **How do I apply?**\nTo apply, simply go to ${channelMention('1156739680994328616')} and click the "Apply for Actor" button. Fill out the form, and our team will review your application.\n\n➡️ **What are the requirements?**\n- Be at least 16 years old.\n- Have a microphone.\n- Speak fluent English.\n\n➡️ **What happens after I apply?**\nAfter you submit your application, a new channel will be created for you where you will be asked to submit an acting test. Our team will review your application and acting test, and if you are accepted, you will receive a role that gives you access to the actor channels and updates about the series. Do note that being accepted can take up to a day or two, depending on how our managers are.\n\n➡️ **Further Clarification**\nThis is not a public SMP. There is no IP to join, and you cannot play whenever you'd like. You can only play when we host recording events in order to contribute to our storyline. For more information, do /faq in ${channelMention('1156740100076617728')}.`)
        .setColor(0x242429);

    await message.delete();
    await message.channel.send({ embeds: [embed] });
  }
});

client.login(token);
