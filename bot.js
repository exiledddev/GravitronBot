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
  StringSelectMenuBuilder,
  GuildPremiumTier,
  AttachmentBuilder,
  TextInputStyle, roleMention, channelMention, userMention, MessageFlags,
} = require('discord.js');
const cron = require('node-cron');
const {
  initializeTemporaryRoleStore,
  grantTemporaryRole,
  processExpiredTemporaryRoles,
  startTemporaryRoleExpirationWorker,
} = require('./temporary-roles');
const {
  initializeSceneStore,
  isSceneStoreReady,
  listScenes,
  createScene,
  getScene,
  setCastMember,
  removeCastMember,
  listCast,
  deleteSceneData,
} = require('./scenes');
const {
  APPLICATION_STATUS,
  initializeApplicationStore,
  isApplicationStoreReady,
  createApplication,
  getApplication,
  listApplications,
  recordAnswer,
  setApplicationState,
  deleteApplication,
  saveApplicationMedia,
  readApplicationMedia,
  removeApplicationMedia,
  blockApplicant,
  getApplicantBlock,
} = require('./applications');
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

  // Temporary role storage: open it, immediately clear anything that expired
  // while the bot was offline, then start the periodic checker.
  try {
    initializeTemporaryRoleStore();

    const recovery = await processExpiredTemporaryRoles({
      client: readyClient,
      notify: sendMediaRankExpirationDM,
    });
    if (recovery.processed > 0 || recovery.failed > 0) {
      console.log(
        `Temporary role startup recovery: ${recovery.processed} processed, ${recovery.skipped} skipped, ${recovery.failed} failed.`,
      );
    }

    startTemporaryRoleExpirationWorker({
      client: readyClient,
      notify: sendMediaRankExpirationDM,
    });
  } catch (error) {
    console.error('Failed to start the temporary role expiration system:', error);
  }

  // Scene ticket storage. A failure here only costs /cast and /callsheet.
  try {
    initializeSceneStore();

    // Channels deleted while the bot was offline never fired channelDelete, so
    // reconcile once at startup the same way temporary roles recover.
    let reconciledScenes = 0;
    for (const scene of listScenes()) {
      const sceneChannel = await readyClient.channels.fetch(scene.channel_id).catch(() => null);
      if (!sceneChannel) {
        deleteSceneData(scene.channel_id);
        reconciledScenes += 1;
      }
    }

    if (reconciledScenes > 0) {
      console.log(`Scene startup reconciliation: dropped ${reconciledScenes} scene(s) whose channel no longer exists.`);
    }
  } catch (error) {
    console.error('Failed to open the scene ticket store:', error);
  }

  // Trusted application storage. A failure here only costs the questionnaire.
  try {
    initializeApplicationStore();

    // A restart between recording an answer and posting the next question would
    // leave the applicant waiting on a prompt that never arrived, so re-post it.
    let repromptedApplications = 0;
    let reconciledApplications = 0;
    for (const application of listApplications()) {
      const channel = await readyClient.channels.fetch(application.channel_id).catch(() => null);
      if (!channel) {
        deleteApplication(application.channel_id);
        reconciledApplications += 1;
        continue;
      }

      if (application.status !== APPLICATION_STATUS.inProgress || !Number.isInteger(application.current_step)) {
        continue;
      }

      const prompt = application.prompt_message_id ?
        await channel.messages.fetch(application.prompt_message_id).catch(() => null) :
        null;

      if (!prompt) {
        await postTrustedQuestion(channel, application, application.current_step).catch((error) => {
          console.error(`Failed to re-post question for application ${application.channel_id}:`, error);
        });
        repromptedApplications += 1;
      }
    }

    if (repromptedApplications > 0 || reconciledApplications > 0) {
      console.log(
        `Trusted application startup recovery: re-prompted ${repromptedApplications}, dropped ${reconciledApplications} for missing channels.`,
      );
    }

    await sweepStaleTrustedApplications(readyClient);
    setInterval(() => {
      sweepStaleTrustedApplications(readyClient).catch((error) => {
        console.error('Trusted application sweep failed:', error);
      });
    }, TRUSTED_APP_SWEEP_INTERVAL_MS);
  } catch (error) {
    console.error('Failed to start the Trusted application system:', error);
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

const APPLY_BUTTON_ID = 'trusted_apply_open';
// Panels posted before the rename still carry the old ids, so they stay accepted.
const LEGACY_APPLY_BUTTON_ID = 'actor_apply_open';
const BUILDER_BUTTON_ID = 'builder_apply_open';
const STAFF_BUTTON_ID = 'staff_apply_open';
const TEAM_BUTTON_ID = 'team_apply_open';
const SUPPORT_BUTTON_ID = 'support_ticket_open';
const BUILDER_MODAL_ID = 'builder_apply_form';
const STAFF_MODAL_ID = 'staff_apply_form';
const TEAM_MODAL_ID = 'team_apply_form';
const SUPPORT_MODAL_ID = 'support_ticket_form';
const MEDIA_BUTTON_ID = 'media_apply_open';
const MEDIA_TIER_SELECT_ID = 'media_apply_tier';
const MEDIA_MODAL_ID = 'media_apply_form';
const TRUSTED_APP_DONE_ID = 'trusted_app_done';
const LEGACY_TRUSTED_APP_DONE_ID = 'actor_app_done';
const TRUSTED_APP_EDIT_ID = 'trusted_app_edit';
const LEGACY_TRUSTED_APP_EDIT_ID = 'actor_app_edit';
const TRUSTED_APP_EDIT_SELECT_ID = 'trusted_app_edit_select';
const LEGACY_TRUSTED_APP_EDIT_SELECT_ID = 'actor_app_edit_select';
const TRUSTED_APP_ACCEPT_ID = 'trusted_app_accept';
const LEGACY_TRUSTED_APP_ACCEPT_ID = 'actor_app_accept';
const TRUSTED_APP_REJECT_ID = 'trusted_app_reject';
const LEGACY_TRUSTED_APP_REJECT_ID = 'actor_app_reject';
const TRUSTED_TOPIC_PREFIX = 'trusted-app:user:';
// Tickets opened before the rename keep this topic and must stay recognisable.
const LEGACY_TRUSTED_TOPIC_PREFIX = 'actor-app:user:';
const BUILDER_TOPIC_PREFIX = 'builder-app:user:';
const STAFF_TOPIC_PREFIX = 'staff-app:user:';
const TEAM_TOPIC_PREFIX = 'team-app:user:';
const SUPPORT_TOPIC_PREFIX = 'support-ticket:user:';
const MEDIA_TOPIC_PREFIX = 'media-app:user:';
const SCENE_TOPIC_PREFIX = 'actor-project:user:';
const ALLOWED_USER_ID = '1273910593539014680';
const ADMIN_ROLE_ID = '1503739527804616836';
const TRUSTED_ROLE_ID = '1503776275645337621';
const BUILDER_ROLE_ID = '1503778122275885121';
// Structured ticket type definitions. Command availability is derived from this
// registry rather than from ad-hoc per-command channel checks.
const TICKET_TYPES = [
  {
    // Trusted applications are decided with the Accept / Reject buttons on the
    // submission embed, so the slash commands deliberately do not apply here.
    // acceptRoleId stays because the Accept button reads it.
    key: 'trusted',
    label: 'Trusted',
    topicPrefix: TRUSTED_TOPIC_PREFIX,
    legacyTopicPrefixes: [LEGACY_TRUSTED_TOPIC_PREFIX],
    acceptRoleId: TRUSTED_ROLE_ID,
    supportsAccept: false,
    supportsReject: false,
    supportsExec: false,
  },
  {
    key: 'builder',
    label: 'Builder',
    topicPrefix: BUILDER_TOPIC_PREFIX,
    acceptRoleId: BUILDER_ROLE_ID,
    supportsAccept: true,
    supportsReject: true,
    supportsExec: false,
  },
  {
    key: 'staff',
    label: 'Staff',
    topicPrefix: STAFF_TOPIC_PREFIX,
    supportsAccept: false,
    supportsReject: false,
    supportsExec: false,
  },
  {
    key: 'team',
    label: 'Team',
    topicPrefix: TEAM_TOPIC_PREFIX,
    supportsAccept: false,
    supportsReject: false,
    supportsExec: false,
  },
  {
    key: 'support',
    label: 'Support',
    topicPrefix: SUPPORT_TOPIC_PREFIX,
    supportsAccept: false,
    supportsReject: false,
    supportsExec: false,
  },
  {
    key: 'media',
    label: 'Media',
    topicPrefix: MEDIA_TOPIC_PREFIX,
    supportsAccept: false,
    supportsReject: true,
    supportsExec: true,
  },
  {
    key: 'scene',
    label: 'Scene',
    topicPrefix: SCENE_TOPIC_PREFIX,
    supportsAccept: false,
    supportsReject: false,
    supportsExec: false,
  },
];
const TICKET_STATS_TYPES = TICKET_TYPES;
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
  'If you had to choose between living in Solaris or hiding out near the Outlands, which side of the realm are you picking?',
  'Do you think Solarflare’s rule of zero private property in Solaris is a total utopia or a ticking time bomb?',
  'What’s your best theory on how that command block error during the Great Merge actually went down?',
  'If you woke up tomorrow stranded in the Island Realm after a ten-year blackout, what’s the first thing you’d try to build?',
  'Are you siding with Exiled on his mission for revenge against Vanguard, or do you think he’s losing it?',
  'If you stumbled across one of the three mythical artifacts that grant immortality, would you use it or hide it?',
  'Epic Clutch’s betrayal: smart survival strategy or the ultimate snake move?',
  'Honestly, how long do you think you’d survive trying to cross those one-block-wide wooden bridges over the void?',
  'What kind of dark secrets do you think are still buried deep inside the labyrinth of Mount Aether?',
  'If you ran into that shady merchant living under the island, what illegal item would you trade your diamonds for?',
  'Are the villagers in those peaceful farming towns actually friendly, or are they hiding something creepy?',
  'What’s your take on that mysterious voice or entity talking to Exiled inside his own head?',
  'If Vanguard forces cornered your base on a floating island right now, what’s your backup escape plan?',
  'Do you think that Sharpness 25 glitched sword is way too overpowered to exist on the server?',
  'What do you think actually happens to players who fall too deep into the void? Is there anything down there?',
  'How would you rate Solaris’s security and police force compared to independent outposts?',
  'If you had to pick a teammate like Kusky to watch your back across the islands, would you trust them?',
  'What’s the most terrifying structure you’ve ever stumbled upon while exploring the outer islands?',
  'Do you think the Outlands are genuinely cursed, or is that just server propaganda to keep people away?',
  'If you could add any custom mechanic or item to the Island Realm lore right now, what would it be?',
  'What do you think was going through the founder’s head when the Overworld and Voidlands first collided?',
  'Is Topad the engineer actually helping out the realm, or is he building traps for everyone else?',
  'If you got banished to the Outlands for a crime you didn\'t commit, how would you fight back?',
  'What’s the deal with those creepy red-eyed structures hidden in the dark forests?',
  'Do you think Exiled’s obsession with finding the artifacts is blinding him from the actual truth?',
  'How do civilizations on islands the size of villages manage their food and resource supply without falling off?',
  'If you had to join one faction in the realm - Solaris, Vanguard, or an independent crew—which one are you picking?',
  'What’s the backstory behind that tavern on the southern side of the realm? Who actually drinks there?',
  'Do you think Epic Clutch actually cares about the realm, or is he just playing a long game?',
  'What kind of music do you think echoes through the void late at night?',
  'If you found an old map with a red X drawn over a random tavern, would you actually follow it?',
  'How do players on the server handle inventory management when everything is constantly breaking?',
  'What’s the most valuable piece of loot you’ve ever lost to the void?',
  'If you had to design a custom defense trap for your island base, what would it do?',
  'Do you think the Great Merge was a total accident, or did someone cause it on purpose?',
  'What do you think the air smells like when you’re standing 200 blocks high on Mount Aether?',
  'If you could have a pet mob roaming around your floating island, what would you choose?',
  'Why do you think so many players in the realm end up turning on each other in the end?',
  'What’s your favorite piece of architecture or build in the entire Island Realm series?',
  'If you met Exiled out on a bridge, would you trade with him or fight him?',
  'What secrets do you think are written in those riddle books found out in the Outlands ruins?',
  'How do you even travel between distant islands when you don’t have an elytra?',
  'If Solaris has zero crime, how do they deal with troublemakers like Epic or Exiled?',
  'What’s the scariest sound you can hear while mining underneath a floating mountain?',
  'Do you think there are other survivors hiding out in dimensions we haven\'t seen yet?',
  'If you could wield any weapon from the series - a mace, a glitched sword, or a custom bow—what’s your pick?',
  'What’s the worst advice you could give someone exploring the Outlands for the very first time?',
  'How do you think the economy in the Great Republic actually functions behind closed doors?',
  'If you were directing the next episode of Island Realm, what plot twist would you drop?',
  'At the end of the day, is saving the Island Realm even worth all the bloodshed?',
  'What project or build are you currently working on in Minecraft right now?',
  'What’s your go-to comfort game when you’re taking a break from building or editing?',
  'Coffee, tea, or energy drinks when you’re pulling a late-night gaming or coding session?',
  'What is one game soundtrack you can listen to on repeat for hours?',
  'If you could instantly master any software or coding language, what would you pick?',
  'What’s the best movie or series you’ve watched recently?',
  'What song are you currently playing on repeat?',
  'Desk setup tour in one sentence: what’s your absolute favorite piece of gear?',
  'If you had a completely free weekend with zero responsibilities, what would you do?',
  'What’s a niche hobby or interest you have that most people don’t know about?',
  'What’s the best snack to have next to your keyboard while gaming?',
  'If you could travel anywhere in the world right now for a quick weekend trip, where are you going?',
  'Are you more of a night owl or an early bird?',
  'What’s the most underrated game of all time in your opinion?',
  'What’s your favorite season of the year and why?',
  'If you could instantly teleport anywhere in your home country right now, where are you heading?',
  'What’s a skill you wish you had learned years ago?',
  'PC gaming or console gaming? Defend your choice.',
  'What’s the best piece of advice you’ve ever received?',
  'If you could add any feature to Discord right now, what would it be?',
  'What’s your favorite kind of weather for staying inside and working on a project?',
  'If you were an NPC in a video game, what would your default dialogue line be?',
  'What’s the most creative thing you’ve built or made this month?',
  'If you had to eat only one meal for the rest of your life, what would it be?',
  'What’s everyone up to today? Drop what you\'re working on right now!'
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
// Actor project ("scene") tickets. They share the builder project category and
// role, and are told apart by their channel topic prefix.
// Trusted application -------------------------------------------------------
// One audition piece is assigned at random when the ticket opens and pinned for
// the life of the application, so editing the answer re-shows the same piece.
const TRUSTED_AUDITION_TESTS = {
  jesse: {
    key: 'jesse',
    character: 'Jesse',
    tested: 'Pacing acceleration, numbness turning into frantic realization.',
    script: [
      '(Staring straight ahead, totally flat)',
      'No. No, that does not make sense. Check the logs again.',
      '(A short, sharp breath, tempo speeds up)',
      'No, do not look at me. Listen to my voice. Am I real to you? Because I cannot feel my hands anymore, and the door behind us was not open a second ago.',
      '(Laughs breathlessly, frantic)',
      'Oh god, it is looping. We are still back at the entry point, are we not?',
    ].join('\n'),
  },
  marcus: {
    key: 'marcus',
    character: 'Marcus',
    tested: 'Controlled calm shifting into a direct, lethal threat.',
    script: [
      '(Softly, almost smiling)',
      'Sit down. Please. Let us not make this harder than it has to be.',
      '(Leaning in, voice dropping completely flat)',
      'You think because you hid the logs on a secondary drive I would not find them? You gave away our coordinates to save your own skin. And now you are sitting here, looking me in the eye, lying to my face.',
      '(A dark, quiet laugh)',
      'God, you really are stupid.',
    ].join('\n'),
  },
  thomas: {
    key: 'thomas',
    character: 'Thomas',
    tested: 'Escalating desperation, bargaining, raw panic.',
    script: [
      '(Grabbing the edge of the table, breathing heavily)',
      'Look at me. Please. Look at me! You have the codes. You are the only one who can override the lock. If you do not do it right now, they are going to breach the outer wall.',
      '(Voice cracks, tears stinging)',
      'I will give you anything. Take my share, take the supplies, just open the damn door! I am not ready to die in here, and neither are you. Do you hear me?',
    ].join('\n'),
  },
  vance: {
    key: 'vance',
    character: 'General Vance',
    tested: 'Zero emotion, absolute control, cold pragmatism.',
    script: [
      '(Calmly cleaning a sidearm, not looking up)',
      'How many men did we lose in the western sector? Forty? Fifty? It does not matter. The bridge is secure, and that is the only metric that counts.',
      '(Pauses, looks up with completely blank eyes)',
      'Tell the captain to clear the remaining tents. Burn whatever is left behind. We leave at dawn. If anyone falls behind, leave them to the frost. We do not slow down for dead weight.',
    ].join('\n'),
  },
};
const TRUSTED_AUDIO_ALLOWED_CONTENT_TYPES = ['audio/', 'video/ogg'];
const TRUSTED_AUDIO_ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.webm', '.mp4'];
const TRUSTED_MINIMUM_AGE = 16;
// Overridable so the questionnaire timers can be shortened while testing.
function readDurationEnv(name, fallbackMs) {
  // The ACTOR_ prefixed names predate the rename and are still honoured.
  const legacyName = name.replace(/^TRUSTED_/, 'ACTOR_');
  const raw = process.env[name] || process.env[legacyName] || '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackMs;
}
const TRUSTED_APP_REMINDER_AFTER_MS = readDurationEnv('TRUSTED_APP_REMINDER_AFTER_MS', 24 * 60 * 60 * 1000);
const TRUSTED_APP_ABANDON_AFTER_MS = readDurationEnv('TRUSTED_APP_ABANDON_AFTER_MS', 72 * 60 * 60 * 1000);
const TRUSTED_APP_SWEEP_INTERVAL_MS = readDurationEnv('TRUSTED_APP_SWEEP_INTERVAL_MS', 10 * 60 * 1000);
const TRUSTED_REAPPLY_COOLDOWN_MS = readDurationEnv('TRUSTED_REAPPLY_COOLDOWN_MS', 7 * 24 * 60 * 60 * 1000);

const SCENE_CATEGORY_ID = PROJECT_CATEGORY_ID;
const SCENE_SCRIPT_ALLOWED_CONTENT_TYPES = ['application/pdf'];
const SCENE_SCRIPT_ALLOWED_EXTENSIONS = ['.pdf'];
// Discord's per-guild upload ceiling. There is no helper for this on Guild, so
// it is derived from the boost tier and used only for a clear error message -
// the send itself is still wrapped in a try/catch.
const SCENE_UPLOAD_LIMIT_BY_TIER = {
  [GuildPremiumTier.Tier2]: 50 * 1024 * 1024,
  [GuildPremiumTier.Tier3]: 100 * 1024 * 1024,
};
const SCENE_DEFAULT_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
const ACCEPTED_READ_FIRST_CHANNEL_ID = '1546086278418927656';
const ACCEPTED_QUESTIONS_CHANNEL_ID = '1546082814284533890';
const HOW_JOIN_CHANNEL_ID = '1506390449516974280';
const HOW_APPLY_CHANNEL_ID = '1507777195190517811';
const EVENT_STAGE_CHANNEL_ID = '1503754828558372894';
const EVENT_MAX_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
const STARTUP_CHANNEL_ID = '1503748268713054461';
// Media Rank system ---------------------------------------------------------
// Single source of truth for the Media Rank tiers. /exec, the temporary role
// storage, expiration handling and the acceptance messages all read from here,
// so adding a future tier only needs a new entry.
const MEDIA_TIERS = {
  media: {
    key: 'media',
    name: 'Media Rank',
    applicationLabel: 'Media',
    emoji: '\ud83c\udfc5',
    roleId: '1551107511694786633',
    viewsRequired: '1k',
  },
  media_plus: {
    key: 'media_plus',
    name: 'Media+ Rank',
    applicationLabel: 'Media+',
    emoji: '\u2728',
    roleId: '1551107707946406018',
    viewsRequired: '2.5k',
  },
  media_partner: {
    key: 'media_partner',
    name: 'Island Realm Media Partner',
    applicationLabel: 'Island Realm Media Partner',
    emoji: '\ud83d\udc51',
    roleId: '1551107839987159050',
    viewsRequired: '5k+',
    customChannelRequired: true,
  },
};
// The media reviewer happens to be the same person as the bot's allowed user,
// but it is a distinct role so it gets its own name.
const MEDIA_REVIEWER_USER_ID = ALLOWED_USER_ID;
const MEDIA_ANNOUNCEMENT_CHANNEL_ID = '1503753701217669151';
const MEDIA_ANNOUNCEMENT_ROLE_ID = '1550904220159582249';
const MEDIA_RENEWAL_CHANNEL_ID = '1551115151686500412';
const MEDIA_PARTNER_PING_ROLE_ID = '1550904026571341906';
const MEDIA_PARTNER_CONTACT = 'markedexiled';
const MEDIA_RANK_EXPIRATION_DAYS = 15;
// Overridable so the expiration can be shortened while testing. Production must
// be left on the 15 day default.
const MEDIA_RANK_DURATION_MS = Number.parseInt(process.env.MEDIA_RANK_DURATION_MS || '', 10) > 0 ?
  Number.parseInt(process.env.MEDIA_RANK_DURATION_MS, 10) :
  MEDIA_RANK_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
const MEDIA_TEMPORARY_ROLE_IDS = Object.values(MEDIA_TIERS).map((tier) => tier.roleId);
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

function getUniqueTrustedChannelName(guild, usernamePart) {
  const base = `🎭trusted-${usernamePart}`.slice(0, 100);
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

function findExistingTrustedApplicationChannel(guild, userId) {
  const markers = [TRUSTED_TOPIC_PREFIX, LEGACY_TRUSTED_TOPIC_PREFIX].map((prefix) => `${prefix}${userId}`);

  return guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      typeof channel.topic === 'string' &&
      markers.some((marker) => channel.topic.startsWith(marker)),
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

    const matchingType = TICKET_STATS_TYPES.find(
      (type) => getTicketTypePrefixes(type).some((prefix) => channel.topic.startsWith(prefix)),
    );
    if (matchingType) {
      counts[matchingType.key] += 1;
    }
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { counts, total };
}

/**
 * Every prefix a ticket type answers to: its current one first, then any it was
 * renamed away from, so channels opened before a rename still resolve.
 */
/**
 * The ticket types a command applies to, as readable text, so refusal messages
 * stay true as the registry changes.
 */
function describeTicketTypesFor(capability) {
  const labels = TICKET_TYPES.filter((type) => type[capability]).map((type) => type.label.toLowerCase());
  if (labels.length === 0) {
    return 'no';
  }

  return labels.length === 1 ?
    labels[0] :
    `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

function getTicketTypePrefixes(ticketType) {
  return [ticketType.topicPrefix, ...(ticketType.legacyTopicPrefixes || [])];
}

function getTicketTypeFromChannel(channel) {
  const channelTopic = channel?.topic;
  if (typeof channelTopic !== 'string') {
    return null;
  }

  return TICKET_TYPES.find(
    (type) => getTicketTypePrefixes(type).some((prefix) => channelTopic.startsWith(prefix)),
  ) || null;
}

/**
 * Which of a type's prefixes this channel actually uses. Parsing has to key off
 * this rather than the current prefix, or a legacy ticket yields no applicant.
 */
function getMatchedTopicPrefix(channel, ticketType) {
  const channelTopic = channel?.topic;
  if (typeof channelTopic !== 'string' || !ticketType) {
    return null;
  }

  return getTicketTypePrefixes(ticketType).find((prefix) => channelTopic.startsWith(prefix)) || null;
}

function getApplicantIdFromChannel(channel) {
  const channelTopic = channel?.topic || '';
  const ticketType = getTicketTypeFromChannel(channel);
  if (!ticketType) {
    return null;
  }

  const matchedPrefix = getMatchedTopicPrefix(channel, ticketType);
  if (!matchedPrefix) {
    return null;
  }

  const topicMatch = channelTopic.match(new RegExp(`^${matchedPrefix}(\\d+)`));
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

  // Scene tickets share this category, so a topic that claims any other ticket
  // type always beats the category fallback below.
  if (getTicketTypeFromChannel(channel)) {
    return false;
  }

  return channel.parentId === PROJECT_CATEGORY_ID;
}

function isSceneChannel(channel) {
  return (
    channel?.type === ChannelType.GuildText &&
    typeof channel.topic === 'string' &&
    channel.topic.startsWith(SCENE_TOPIC_PREFIX)
  );
}

function getUniqueSceneChannelName(guild, sceneName) {
  const base = `\ud83c\udfacscene-${sanitizeProjectChannelName(sceneName)}`.slice(0, 100);
  let candidate = base;
  let index = 2;

  while (guild.channels.cache.some((channel) => channel.name === candidate) && index < 100) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    index += 1;
  }

  return candidate;
}

function getGuildUploadLimitBytes(guild) {
  return SCENE_UPLOAD_LIMIT_BY_TIER[guild?.premiumTier] ?? SCENE_DEFAULT_UPLOAD_LIMIT_BYTES;
}

/**
 * Validate a scene script upload before anything is created, so a bad file never
 * leaves an orphaned ticket behind.
 */
function validateSceneScript(attachment, guild) {
  if (!attachment) {
    return { ok: true, attachment: null };
  }

  const fileName = String(attachment.name || '');
  const contentType = String(attachment.contentType || '').toLowerCase();
  const hasAllowedType = SCENE_SCRIPT_ALLOWED_CONTENT_TYPES.some((type) => contentType.startsWith(type));
  const hasAllowedExtension = SCENE_SCRIPT_ALLOWED_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext));

  // contentType can be absent, so the extension is accepted as a fallback.
  if (!hasAllowedType && !hasAllowedExtension) {
    return { ok: false, reason: `The script has to be a PDF. \`${truncateForEmbed(fileName, 100)}\` is not one.` };
  }

  const uploadLimit = getGuildUploadLimitBytes(guild);
  if (attachment.size > uploadLimit) {
    const limitMb = Math.floor(uploadLimit / (1024 * 1024));
    return { ok: false, reason: `That script is larger than this server's ${limitMb}MB upload limit, so I cannot re-post it.` };
  }

  return { ok: true, attachment };
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

/**
 * A plain, readable label for a user. Mentions can render as a raw id or as
 * "unknown user" once someone has left, so reports carry the username too.
 */
function formatUserLabel(user) {
  if (!user) {
    return 'Unknown';
  }

  // Accounts migrated to the new username system report a '0' discriminator.
  const username = user.discriminator && user.discriminator !== '0' ? user.tag : user.username;
  const displayName = user.globalName || null;

  if (!username) {
    return 'Unknown';
  }

  return displayName && displayName !== username ? `${username} (${displayName})` : `${username}`;
}

function buildBanReportEmbed({
  inputUserArgument,
  durationLabel,
  deleteMessages,
  userId,
  bannedUserLabel,
  reason,
  banTag,
  issuedByLabel,
  issuedById,
}) {
  const issuedByLine = issuedById ?
    `**Issued By:** <@${issuedById}> \u2013 \`${issuedByLabel}\` (${issuedById})` :
    `**Issued By:** ${issuedByLabel}`;

  return new EmbedBuilder()
    .setTitle('Action Report - Ban Issued')
    .setDescription(truncateForEmbed(
      [
        `**Input User Argument:** ${inputUserArgument}`,
        `**Duration:** ${durationLabel}`,
        `**Delete Messages:** ${deleteMessages ? 'Yes' : 'No'}`,
        '',
        `**Banned User:** <@${userId}>`,
        `**Banned Username:** \`${bannedUserLabel}\``,
        `**Banned User ID:** ${userId}`,
        '',
        issuedByLine,
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

function buildEventEmbed({ isLive, startTimestampSeconds, ip, version, players, authorName, authorIconURL }) {
  const timeFieldValue = isLive ?
    `\ud83d\udd34 **LIVE NOW** \u2013 started <t:${startTimestampSeconds}:R>` :
    `<t:${startTimestampSeconds}:R>\n<t:${startTimestampSeconds}:F>`;

  // Headings stay at h3 so the call to action reads smaller than the embed title.
  const description = isLive ?
    `### \ud83d\udd34 Join ${channelMention(EVENT_STAGE_CHANNEL_ID)} to be in the video.` :
    [
      `### \u26a0\ufe0f To participate, join ${channelMention(EVENT_STAGE_CHANNEL_ID)} or you will miss out on instructions and get banned.`,
      'All instructions will be listed in the stage channel by one of our Production Managers.',
    ].join('\n');

  const eventEmbed = new EmbedBuilder()
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

  if (authorName) {
    // The avatar is decoration: drop a malformed icon URL rather than letting
    // setAuthor throw and take the whole announcement down with it.
    const hasUsableIcon = typeof authorIconURL === 'string' && /^https?:\/\//.test(authorIconURL);
    eventEmbed.setAuthor({
      name: truncateForEmbed(`${authorName} is RECORDING!`, 256),
      ...(hasUsableIcon ? { iconURL: authorIconURL } : {}),
    });
  }

  return eventEmbed;
}

function getUniqueMediaChannelName(guild, usernamePart) {
  const base = `\ud83c\udfacmedia-${usernamePart}`.slice(0, 100);
  let candidate = base;
  let index = 2;

  while (guild.channels.cache.some((channel) => channel.name === candidate) && index < 100) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    index += 1;
  }

  return candidate;
}

function findExistingMediaTicketChannel(guild, userId) {
  const marker = `${MEDIA_TOPIC_PREFIX}${userId}`;

  return guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        typeof channel.topic === 'string' &&
        channel.topic.startsWith(marker),
  );
}

function buildMediaPanelDescription(value) {
  if (value.length > 4096) {
    console.error(
      `Media panel description is ${value.length} characters, over Discord's 4096 limit. It has been truncated - shorten the wording in buildMediaRankEmbed.`,
    );
  }

  return truncateForEmbed(value, 4096);
}

function buildMediaTierRequirements(tier) {
  return [
    '\ud83d\udcdc **Requirements**',
    '\u2022 Must be related to Island Realm',
    '\u2022 Can be a gameplay clip, edit, funny moment, showcase, montage, lore video etc.',
    `\u2022 Must reach ${tier.viewsRequired} views on the video you're applying with.`,
    '\u2022 Submit proof of the views in the ticket when you open it, along a link to the video you\'re applying with.',
    '\u2022 Include the Island Realm Discord invite in the comment section, pinned (unless it is tiktok and you can\'t pin comments, you still need to send it in the comments however and keep it as visible as possible).',
  ].join('\n');
}

function buildMediaTierSection(tier, benefits) {
  return [
    `## ${tier.emoji} ${tier.name}`,
    buildMediaTierRequirements(tier),
    '',
    '\ud83c\udf81 **Benefits**',
    ...benefits,
  ].join('\n');
}

function buildMediaRankEmbed() {
  // Everything lives in the description on purpose: Discord renders markdown
  // headings in an embed description but prints them literally inside embed
  // field values, and field names cannot be resized at all. The description is
  // the only place a real size hierarchy is possible.
  const description = [
    '# \ud83c\udfac Island Realm Media Rank',
    '\ud83d\udcdc Terms & Tiers',
    '',
    '### \ud83d\ude80 Want to become a part of the Island Realm team?',
    'Create and post a Short/TikTok, or any other content related to Island Realm and reach the amount of views required by any tier to unlock your own custom media rank!',
    '',
    `\ud83d\udca1 The Media Rank must be renewed every ${MEDIA_RANK_EXPIRATION_DAYS} days or it will automatically expire.`,
    '',
    buildMediaTierSection(MEDIA_TIERS.media, [
      `\u2022 ${roleMention(MEDIA_TIERS.media.roleId)} role in our discord server, giving you a cool name color and distinctiveness from other members.`,
    ]),
    '',
    buildMediaTierSection(MEDIA_TIERS.media_plus, [
      `\u2022 ${roleMention(MEDIA_TIERS.media_plus.roleId)} role in our discord server, giving you an even cooler name color and separating you from other members in the members tab on the right side of the discord server.`,
      '\u2022 Higher order priority in the right side of the discord server in the members page, making you more visible to everyone.',
    ]),
    '',
    buildMediaTierSection(MEDIA_TIERS.media_partner, [
      `\u2022 ${roleMention(MEDIA_TIERS.media_partner.roleId)} role in our discord server, giving you the coolest name color you can have and separating you from other members in the members tab.`,
      '\u2022 Higher order priority in the right side of the discord server in the members page, making you more visible to everyone.',
      `\u2022 Your own custom channel where you can post your new videos related to the Island Realm, so all of our members can see it, and the permission to ping ${roleMention(MEDIA_PARTNER_PING_ROLE_ID)} for it.`,
    ]),
    '',
    '## \ud83c\udf0e Global Benefits',
    '\u2022 All Media Rank tiers offer you official recognition as part of our team and from us.',
    '',
    '### \u23f3 Renewal',
    `When the media rank is given to a member, it expires in ${MEDIA_RANK_EXPIRATION_DAYS} days from the date that it was given from.`,
    '',
    'To renew it, open a new media ticket with a new video that meets the criteria.',
    '',
    '\u26a0\ufe0f Videos submitted must not be older than 1 week.',
  ].join('\n');

  return new EmbedBuilder()
    .setDescription(buildMediaPanelDescription(description))
    .setFooter({ text: `Northstar Utils [v${BOT_VERSION}]` })
    .setColor(0x242429);
}


function buildMediaApplicationEmbed({ applicantId, name, age, videoUrl, tier, notes }) {
  const applicationEmbed = new EmbedBuilder()
    .setTitle('\ud83c\udfac Media Rank Application')
    .addFields(
      { name: '\ud83d\udc64 Applicant', value: `<@${applicantId}>`, inline: false },
      { name: '\ud83d\udcdd Name', value: truncateForEmbed(name, 1024), inline: true },
      { name: '\ud83c\udf82 Age', value: truncateForEmbed(age, 1024), inline: true },
      { name: '\ud83c\udfc6 Media Tier Wanted', value: `${tier.emoji} ${tier.name}`, inline: true },
      { name: '\ud83c\udfa5 Video', value: truncateForEmbed(videoUrl, 1024), inline: false },
    )
    .setFooter({ text: 'Please do not ping anyone until we review your application.' })
    .setColor(0xFF0000)
    .setTimestamp();

  if (notes) {
    applicationEmbed.addFields({ name: '\ud83d\udccc Additional Notes', value: truncateForEmbed(notes, 1024), inline: false });
  }

  return applicationEmbed;
}

function buildMediaAcceptanceEmbed({ tier, displayName }) {
  // Embed titles do not render mentions, so the applicant's display name is used
  // in the title and the mention is carried by the message content instead.
  const acceptanceEmbed = new EmbedBuilder()
    .setTitle(truncateForEmbed(`\ud83c\udf89 Congratulations ${displayName}!`, 256))
    .setDescription(`You have been accepted for the **${tier.name}** role.`)
    .setColor(0x242429)
    .setFooter({ text: `Island Realm \u2013 Media Rank \u2022 Expires in ${MEDIA_RANK_EXPIRATION_DAYS} days` })
    .setTimestamp();

  if (tier.customChannelRequired) {
    acceptanceEmbed.addFields({
      name: '\ud83d\udcfa Custom Channel',
      value: `DM Exiled (\`${MEDIA_PARTNER_CONTACT}\`) for your custom channel creation in our server.`,
    });
  }

  return acceptanceEmbed;
}

function buildMediaExpirationEmbed() {
  return new EmbedBuilder()
    .setTitle('\u23f0 Your Media Rank has expired.')
    .setDescription(`Please renew it by following the instructions in ${channelMention(MEDIA_RENEWAL_CHANNEL_ID)}`)
    .setColor(0x242429)
    .setFooter({ text: `Northstar Utils [v${BOT_VERSION}]` })
    .setTimestamp();
}

function buildMediaAnnouncementEmbed({ applicantId, tier }) {
  return new EmbedBuilder()
    .setTitle('\ud83c\udf89 A new member joined the Island Realm team!')
    .setDescription(
      [
        `<@${applicantId}> has joined the Island Realm team through the Media Rank program.`,
        '',
        `They earned the ${roleMention(tier.roleId)} rank \u2013 go give them a warm welcome!`,
      ].join('\n'),
    )
    .setColor(0x242429)
    .setFooter({ text: `Northstar Utils [v${BOT_VERSION}]` })
    .setTimestamp();
}

/**
 * Confirms the bot can actually hand out a role before it claims to have done so.
 */
function canBotAssignRole(guild, role) {
  const botMember = guild.members.me;
  if (!botMember || !role) {
    return false;
  }

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return false;
  }

  return role.managed !== true && botMember.roles.highest.comparePositionTo(role) > 0;
}

async function sendMediaRankExpirationDM({ member }) {
  await member.send({ embeds: [buildMediaExpirationEmbed()] });
}

function buildSceneDetailsEmbed({ sceneName, episode, director, deadline, scriptFileName, createdByTag }) {
  const detailFields = [
    { name: 'Episode / Chapter', value: truncateForEmbed(episode, 1024), inline: true },
    { name: 'Scene Director', value: `<@${director}>`, inline: true },
    { name: 'Deadline', value: truncateForEmbed(deadline || 'Not specified.', 1024), inline: true },
  ];

  if (scriptFileName) {
    detailFields.push({ name: 'Script', value: truncateForEmbed(`\`${scriptFileName}\``, 1024), inline: false });
  }

  return new EmbedBuilder()
    .setTitle(`${sceneName} \u2013 Scene Details`.slice(0, 256))
    .setDescription('A new Island Realm scene ticket has been opened. Use `/cast` to cast someone in a part and `/callsheet` to read the cast back.')
    .addFields(...detailFields)
    .setColor(0x242429)
    .setFooter({ text: `Created by ${createdByTag}` })
    .setTimestamp();
}

function buildCastDMEmbed({ sceneName, roleName, episode, channelId }) {
  return new EmbedBuilder()
    .setTitle('\ud83c\udfad You have been cast!')
    .setDescription(
      [
        `You are playing **${truncateForEmbed(roleName, 500)}** in **${truncateForEmbed(sceneName, 500)}**.`,
        '',
        `Head to ${channelMention(channelId)} for the script and the details.`,
      ].join('\n'),
    )
    .addFields({ name: 'Episode / Chapter', value: truncateForEmbed(episode, 1024), inline: true })
    .setColor(0x242429)
    .setFooter({ text: 'Island Realm \u2013 Northstar Media' })
    .setTimestamp();
}

/**
 * The call sheet. Cast lines go in the description rather than in fields: an
 * embed allows only 25 fields but 4096 description characters, which holds a far
 * larger cast.
 */
function buildCallsheetEmbed({ scene, castLines, castCount }) {
  const header = [
    `**Episode / Chapter:** ${truncateForEmbed(scene.episode, 200)}`,
    `**Scene Director:** <@${scene.director_id}>`,
    `**Deadline:** ${truncateForEmbed(scene.deadline || 'Not specified.', 200)}`,
  ];

  if (scene.script_file_name) {
    header.push(`**Script:** \`${truncateForEmbed(scene.script_file_name, 200)}\``);
  }

  const body = castLines.length ?
    castLines.join('\n') :
    '_No one is cast yet. Use_ `/cast` _to add someone._';

  return new EmbedBuilder()
    .setTitle(`${scene.name} \u2013 Call Sheet`.slice(0, 256))
    .setDescription(truncateForEmbed([...header, '', `**Cast (${castCount})**`, body].join('\n'), 4096))
    .setColor(0x242429)
    .setFooter({ text: `Northstar Utils [v${BOT_VERSION}]` })
    .setTimestamp();
}

function pickAuditionTest() {
  const keys = Object.keys(TRUSTED_AUDITION_TESTS);
  return TRUSTED_AUDITION_TESTS[keys[Math.floor(Math.random() * keys.length)]];
}

function generateApplicationReference() {
  return `APP-${generateBanId()}`;
}

function isAudioAttachment(attachment) {
  const fileName = String(attachment?.name || '').toLowerCase();
  const contentType = String(attachment?.contentType || '').toLowerCase();

  // contentType can be absent, so the extension is accepted as a fallback.
  return (
    TRUSTED_AUDIO_ALLOWED_CONTENT_TYPES.some((type) => contentType.startsWith(type)) ||
    TRUSTED_AUDIO_ALLOWED_EXTENSIONS.some((ext) => fileName.endsWith(ext))
  );
}

function extractFirstUrl(text) {
  const match = String(text || '').match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

/**
 * Each question owns its own prompt and validation, so the questionnaire is
 * driven entirely by this list - asking, re-asking on edit and rendering the
 * review all read from it.
 */
const TRUSTED_APPLICATION_QUESTIONS = [
  {
    key: 'minecraft_username',
    slot: null,
    label: 'Minecraft Username',
    emoji: '\u26cf\ufe0f',
    title: 'What is your Minecraft Username?',
    instructions: 'Reply with your **exact** Minecraft Java username, nothing else. We use it to whitelist you if you are accepted, so a typo here costs you a recording session.',
    validate: (message) => {
      const text = message.content.trim();
      if (!text) {
        return { ok: false, reason: 'Please reply with your Minecraft username.' };
      }

      if (!/^[A-Za-z0-9_]{3,16}$/.test(text)) {
        return { ok: false, reason: 'That does not look like a Minecraft Java username. They are 3-16 characters, letters, numbers and underscores only.' };
      }

      return { ok: true, answer: { text } };
    },
    render: (answer) => `\`${answer.text}\``,
  },
  {
    key: 'age',
    slot: null,
    label: 'Age',
    emoji: '\ud83c\udf82',
    title: 'How old are you?',
    instructions: 'Reply with your age as a number. We ask because our series contains mature themes.',
    validate: (message) => {
      const text = message.content.trim();
      const parsed = Number.parseInt(text, 10);

      if (!/^\d{1,3}$/.test(text) || !Number.isInteger(parsed) || parsed < 1 || parsed > 120) {
        return { ok: false, reason: 'Please reply with your age as a plain number, for example `17`.' };
      }

      return { ok: true, answer: { text, value: parsed } };
    },
    render: (answer) => (
      answer.value < TRUSTED_MINIMUM_AGE ?
        `${answer.value} \u26a0\ufe0f **under ${TRUSTED_MINIMUM_AGE}**` :
        `${answer.value}`
    ),
  },
  {
    key: 'audition',
    slot: 'audition',
    label: 'Audition Voiceover',
    emoji: '\ud83c\udfad',
    title: 'Audition Test',
    instructions: 'This test measures your acting ability. Perform the scene below to the best of your ability, putting everything you have into the emotions it calls for - this is the most important part of your application.\n\nReply with an **audio file** of your performance. If the file is too large to upload, reply with a link to it instead.',
    audio: true,
    render: (answer) => (
      answer.fileName ? `\`${answer.fileName}\`` : (answer.link ? answer.link : '_Not provided._')
    ),
  },
  {
    key: 'introduction',
    slot: 'introduction',
    label: 'Introduction Voiceover',
    emoji: '\ud83c\udf99\ufe0f',
    title: 'Introduce Yourself',
    instructions: 'This one is about your natural speaking voice, not acting. Tell us who you are, what you enjoy, and why you want to join the Island Realm.\n\nReply with an **audio file** between 30 seconds and 1 minute long. If the file is too large to upload, reply with a link to it instead.',
    audio: true,
    render: (answer) => (
      answer.fileName ? `\`${answer.fileName}\`` : (answer.link ? answer.link : '_Not provided._')
    ),
  },
];

/**
 * Audio answers take either an attachment or, when the file is too big for
 * Discord, a link.
 */
function validateAudioAnswer(message, guild) {
  const attachment = message.attachments?.first?.() ?? null;

  if (attachment) {
    if (!isAudioAttachment(attachment)) {
      return { ok: false, reason: `\`${truncateForEmbed(String(attachment.name || 'that file'), 80)}\` does not look like an audio file. Upload an audio recording, or reply with a link to it.` };
    }

    const uploadLimit = getGuildUploadLimitBytes(guild);
    if (attachment.size > uploadLimit) {
      const limitMb = Math.floor(uploadLimit / (1024 * 1024));
      return { ok: false, reason: `That file is over this server's ${limitMb}MB upload limit. Reply with a link to it instead.` };
    }

    return {
      ok: true,
      answer: { fileName: attachment.name, size: attachment.size, contentType: attachment.contentType || null },
      attachment,
    };
  }

  const link = extractFirstUrl(message.content);
  if (link) {
    return { ok: true, answer: { link: truncateForEmbed(link, 400) } };
  }

  return { ok: false, reason: 'Please upload an audio file, or reply with a link to your recording.' };
}

function buildTrustedQuestionEmbed(question, application) {
  const stepNumber = TRUSTED_APPLICATION_QUESTIONS.indexOf(question) + 1;
  const embed = new EmbedBuilder()
    .setTitle(`${question.emoji} ${question.title}`.slice(0, 256))
    .setColor(0x242429)
    .setFooter({ text: `Question ${stepNumber} of ${TRUSTED_APPLICATION_QUESTIONS.length} \u2022 ${application.reference}` });

  if (question.key === 'audition') {
    const audition = TRUSTED_AUDITION_TESTS[application.audition_key] ?? TRUSTED_AUDITION_TESTS.jesse;
    embed.setDescription(truncateForEmbed([
      question.instructions,
      '',
      `**Character:** ${audition.character}`,
      `**What it tests:** ${audition.tested}`,
      '',
      audition.script.split('\n').map((line) => `> ${line}`).join('\n'),
    ].join('\n'), 4096));
  } else {
    embed.setDescription(truncateForEmbed(question.instructions, 4096));
  }

  return embed;
}

function buildTrustedApplicationSummaryEmbed({ application, applicantId, title, description, colour }) {
  const fields = TRUSTED_APPLICATION_QUESTIONS.map((question) => {
    const answer = application.answers[question.key];
    return {
      name: `${question.emoji} ${question.label}`,
      value: truncateForEmbed(answer ? question.render(answer) : '_Not answered._', 1024),
      inline: question.slot === null,
    };
  });

  const audition = TRUSTED_AUDITION_TESTS[application.audition_key];

  return new EmbedBuilder()
    .setTitle(truncateForEmbed(title, 256))
    .setDescription(truncateForEmbed(description, 4096))
    .addFields(
      { name: '\ud83d\udc64 Applicant', value: `<@${applicantId}>`, inline: true },
      { name: '\ud83c\udd94 Applicant ID', value: `\`${applicantId}\``, inline: true },
      { name: '\ud83d\udcdb Username', value: truncateForEmbed(`\`${application.applicant_tag}\``, 1024), inline: true },
      ...fields,
      { name: '\ud83c\udfac Audition Piece', value: audition ? `${audition.character} \u2013 _${audition.tested}_` : 'Unknown', inline: false },
    )
    .setColor(colour)
    .setFooter({ text: `${application.reference} \u2022 Northstar Utils [v${BOT_VERSION}]` })
    .setTimestamp();
}

/**
 * Re-upload the stored voiceovers from disk. The originals live in messages that
 * get purged, and Discord CDN links expire, so disk is the only durable source.
 */
function buildTrustedApplicationFiles(channelId) {
  const files = [];

  for (const question of TRUSTED_APPLICATION_QUESTIONS) {
    if (!question.slot) {
      continue;
    }

    const stored = readApplicationMedia(channelId, question.slot);
    if (stored) {
      const extension = stored.filePath.slice(stored.filePath.lastIndexOf('.'));
      files.push(new AttachmentBuilder(stored.buffer, { name: `${question.slot}${extension}` }));
    }
  }

  return files;
}

async function downloadAttachmentBuffer(attachment) {
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`Attachment download failed with status ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function isTrustedApplicationChannel(channel) {
  return getTicketTypeFromChannel(channel)?.key === 'trusted';
}

/**
 * Delete every message in a ticket channel except one.
 *
 * bulkDelete takes at most 100 ids per call and silently refuses anything older
 * than 14 days, so this chunks and then mops up the survivors individually.
 */
async function purgeChannelExcept(channel, keepMessageId) {
  let deleted = 0;

  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const removable = [...messages.values()].filter((message) => message.id !== keepMessageId);

    for (let index = 0; index < removable.length; index += 100) {
      const chunk = removable.slice(index, index + 100);
      try {
        const removed = await channel.bulkDelete(chunk, true);
        deleted += removed.size;
      } catch (error) {
        console.error('Bulk delete failed, falling back to individual deletes:', error);
      }
    }

    // Anything bulkDelete skipped (older than 14 days) goes one at a time.
    const leftovers = await channel.messages.fetch({ limit: 100 });
    for (const message of leftovers.values()) {
      if (message.id === keepMessageId) {
        continue;
      }

      try {
        await message.delete();
        deleted += 1;
      } catch (error) {
        console.error(`Failed to delete message ${message.id} while purging:`, error);
      }
    }
  } catch (error) {
    console.error('Failed to purge the application channel:', error);
  }

  return deleted;
}

/**
 * Ask one question and remember which message carries it, so a restart can tell
 * whether the applicant is actually waiting on a prompt that never arrived.
 */
async function postTrustedQuestion(channel, application, stepIndex) {
  const question = TRUSTED_APPLICATION_QUESTIONS[stepIndex];
  if (!question) {
    return null;
  }

  const prompt = await channel.send({
    content: `<@${application.applicant_id}>`,
    embeds: [buildTrustedQuestionEmbed(question, application)],
    allowedMentions: { users: [application.applicant_id] },
  });

  setApplicationState(channel.id, {
    status: APPLICATION_STATUS.inProgress,
    currentStep: stepIndex,
    promptMessageId: prompt.id,
  });

  return prompt;
}

function buildTrustedReviewComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(TRUSTED_APP_DONE_ID)
        .setLabel('Done')
        .setEmoji('\u2705')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(TRUSTED_APP_EDIT_ID)
        .setLabel('Edit an answer')
        .setEmoji('\u270f\ufe0f')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildTrustedDecisionComponents(applicantId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${TRUSTED_APP_ACCEPT_ID}:${applicantId}`)
        .setLabel('Accept')
        .setEmoji('\u2705')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${TRUSTED_APP_REJECT_ID}:${applicantId}`)
        .setLabel('Reject')
        .setEmoji('\u274c')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

async function postTrustedReview(channel, application) {
  const reviewEmbed = buildTrustedApplicationSummaryEmbed({
    application,
    applicantId: application.applicant_id,
    title: '\ud83d\udcdd Check your application',
    description: 'Here is everything you have given us. Listen back to your recordings, then either send it to our team or go back and change an answer.',
    colour: 0x242429,
  });

  const message = await channel.send({
    content: `<@${application.applicant_id}>`,
    embeds: [reviewEmbed],
    files: buildTrustedApplicationFiles(channel.id),
    components: buildTrustedReviewComponents(),
    allowedMentions: { users: [application.applicant_id] },
  });

  setApplicationState(channel.id, {
    status: APPLICATION_STATUS.review,
    currentStep: null,
    editingStep: null,
    promptMessageId: message.id,
  });

  return message;
}

/**
 * Record an answer and move the applicant along: next question, or the review
 * step when the questionnaire is finished (or when they were editing one answer).
 */
async function advanceTrustedApplication(channel, application, question, answer) {
  const stepIndex = TRUSTED_APPLICATION_QUESTIONS.indexOf(question);
  const wasEditing = application.editing_step !== null && application.editing_step !== undefined;
  const nextStep = wasEditing ? null : stepIndex + 1;
  const isFinished = wasEditing || nextStep >= TRUSTED_APPLICATION_QUESTIONS.length;

  const updated = recordAnswer({
    channelId: channel.id,
    questionKey: question.key,
    answer,
    nextStep: isFinished ? null : nextStep,
    status: isFinished ? APPLICATION_STATUS.review : APPLICATION_STATUS.inProgress,
  });

  if (!updated) {
    return null;
  }

  if (isFinished) {
    await postTrustedReview(channel, updated);
  } else {
    await postTrustedQuestion(channel, updated, nextStep);
  }

  return updated;
}

/**
 * Finish an application: post the submission first so a failure can never leave
 * an empty channel, then purge, lock the applicant out and archive.
 */
async function submitTrustedApplication(channel, application) {
  const applicantId = application.applicant_id;
  const notes = [];

  const submissionEmbed = buildTrustedApplicationSummaryEmbed({
    application,
    applicantId,
    title: '\ud83c\udfad Trusted Application',
    description: `Submitted by <@${applicantId}>. Use the buttons below to decide.`,
    colour: 0xFF0000,
  });

  const submissionMessage = await channel.send({
    content: `${roleMention(ADMIN_ROLE_ID)}`,
    embeds: [submissionEmbed],
    files: buildTrustedApplicationFiles(channel.id),
    components: buildTrustedDecisionComponents(applicantId),
    allowedMentions: { roles: [ADMIN_ROLE_ID] },
  });

  await purgeChannelExcept(channel, submissionMessage.id);

  // Lock the applicant out: the ticket is now a staff review surface.
  try {
    await channel.permissionOverwrites.edit(
      applicantId,
      { ViewChannel: false, SendMessages: false },
      { reason: 'Trusted application submitted.' },
    );
  } catch (error) {
    console.error('Failed to revoke applicant access after submission:', error);
    notes.push('could not revoke the applicant\'s channel access');
  }

  // Archive to the alert channel with the id and username, so the recordings
  // outlive the ticket and the applicant stays findable.
  const archiveEmbed = new EmbedBuilder()
    .setTitle('Action Report - Trusted Application Submitted')
    .setDescription(truncateForEmbed([
      `**Reference:** ${application.reference}`,
      `**Applicant:** <@${applicantId}> (${applicantId})`,
      `**Username:** ${application.applicant_tag}`,
      `**Ticket:** ${channel} (${channel.id})`,
      '',
      '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
      ...TRUSTED_APPLICATION_QUESTIONS.map((question) => {
        const answer = application.answers[question.key];
        return `**${question.label}:** ${answer ? question.render(answer) : 'Not answered.'}`;
      }),
    ].join('\n'), 4096))
    .setColor(0x242429)
    .setTimestamp();

  const alertChannel = await resolveGuildTextChannel(channel.guild, BAN_REPORT_CHANNEL_ID);
  if (alertChannel) {
    try {
      await alertChannel.send({
        embeds: [archiveEmbed],
        files: buildTrustedApplicationFiles(channel.id),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error('Failed to archive the Trusted application:', error);
      notes.push('could not archive the recordings');
    }
  } else {
    notes.push('could not resolve the archive channel');
  }

  setApplicationState(channel.id, {
    status: APPLICATION_STATUS.submitted,
    currentStep: null,
    editingStep: null,
    promptMessageId: submissionMessage.id,
    submittedAt: new Date().toISOString(),
  });

  // The recordings now live on the submission and the archive, so the local
  // copies are no longer needed.
  if (notes.length === 0) {
    removeApplicationMedia(channel.id);
  }

  try {
    const applicant = await channel.guild.members.fetch(applicantId);
    await applicant.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('\u2705 Application submitted')
          .setDescription([
            'Thanks for applying for **Trusted** in the **Island Realm**!',
            '',
            'Your application is now with our team and you will hear back from us shortly.',
          ].join('\n'))
          .addFields({ name: 'Reference', value: `\`${application.reference}\``, inline: true })
          .setColor(0x242429)
          .setFooter({ text: 'Island Realm \u2013 Northstar Media' })
          .setTimestamp(),
      ],
    });
  } catch (error) {
    console.error('Failed to DM the applicant after submission:', error);
    notes.push('could not DM the applicant');
  }

  if (notes.length > 0) {
    console.error(`Trusted application ${application.reference} submitted with problems: ${notes.join('; ')}.`);
  }

  return { submissionMessage, notes };
}

/**
 * Nudge stalled applications, then close the ones that were truly abandoned, so
 * half-finished tickets do not pile up forever.
 */
async function sweepStaleTrustedApplications(client) {
  if (!isApplicationStoreReady()) {
    return { reminded: 0, closed: 0 };
  }

  const summary = { reminded: 0, closed: 0 };
  const now = Date.now();

  for (const application of listApplications(APPLICATION_STATUS.inProgress)) {
    try {
      const idleMs = now - new Date(application.updated_at).getTime();
      if (!Number.isFinite(idleMs)) {
        continue;
      }

      const channel = await client.channels.fetch(application.channel_id).catch(() => null);
      if (!channel) {
        deleteApplication(application.channel_id);
        continue;
      }

      if (idleMs >= TRUSTED_APP_ABANDON_AFTER_MS) {
        try {
          const applicant = await channel.guild.members.fetch(application.applicant_id);
          await applicant.send(
            'Your Island Realm Trusted application was closed because it sat unfinished for too long. You are welcome to start a new one whenever you are ready.',
          );
        } catch (error) {
          console.error('Failed to DM an applicant about an abandoned application:', error);
        }

        await channel.delete('Trusted application abandoned.').catch((error) => {
          console.error('Failed to delete an abandoned application channel:', error);
        });
        summary.closed += 1;
        continue;
      }

      if (idleMs >= TRUSTED_APP_REMINDER_AFTER_MS && !application.reminded_at) {
        try {
          const applicant = await channel.guild.members.fetch(application.applicant_id);
          await applicant.send(
            `You still have an unfinished Trusted application in ${channelMention(application.channel_id)}. Reply there to pick up where you left off.`,
          );
        } catch (error) {
          console.error('Failed to DM an application reminder:', error);
        }

        setApplicationState(application.channel_id, { remindedAt: new Date().toISOString() });
        summary.reminded += 1;
      }
    } catch (error) {
      console.error(`Failed to sweep Trusted application ${application.channel_id}:`, error);
    }
  }

  return summary;
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
        .setDescription(`Latest feature updates for Northstar Utils v${BOT_VERSION} \u2013 the Island Realm Media Rank update.`)
        .addFields(
          {
            name: 'Version',
            value: `Northstar Utils v${BOT_VERSION}`,
          },
          {
            name: '\ud83c\udfad Trusted applications (renamed + reworked)',
            value: 'The Actor application is now the **Trusted** application, and applying no longer opens a form. The bot asks the questions one at a time in your ticket and records each reply: Minecraft username, age, a voiceover of a randomly assigned audition piece, and a short introduction recording. At the end you can review everything and redo any answer before sending it. Submitting clears the ticket down to one embed with both recordings, hands it to the team with Accept / Reject buttons, and DMs you a confirmation. `/accept` and `/reject` no longer apply to these tickets. Tickets and panels from before the rename keep working.',
          },
          {
            name: '\ud83c\udfad Split application panels',
            value: '`posttrustedembed` and `postbuilderembed` replace `postappembed`, so the Trusted and Builder panels can live in different channels.',
          },
          {
            name: '\ud83c\udfac Scene tickets (NEW)',
            value: '`/scene` opens an actor project ticket for a scene, with the script PDF attached to the command - the bot re-posts and pins it in the channel. `/cast` casts someone in a part, giving them channel access and DMing them, `/uncast` drops them again, and `/callsheet` lists everyone cast and the part they play. Scene tickets are counted in `/ticketstats`.',
          },
          {
            name: '\ud83c\udfac Media Rank system (NEW)',
            value: `\`~$postmediaembed\` posts the Island Realm Media Rank panel with an "Apply for Media" button. Applicants pick a tier (${MEDIA_TIERS.media.applicationLabel}, ${MEDIA_TIERS.media_plus.applicationLabel}, ${MEDIA_TIERS.media_partner.applicationLabel}), fill in a short form, and the bot opens a \`media-\` ticket pinging the media reviewer with every submitted detail.`,
          },
          {
            name: '\u2699\ufe0f /exec command (NEW)',
            value: `Grants the Media Rank tier to the applicant of the media ticket it is run in, resolved from the ticket itself rather than a user argument. Sends the acceptance DM, and with \`announce: true\` posts a team announcement in ${channelMention(MEDIA_ANNOUNCEMENT_CHANNEL_ID)}. Built so more execution types can be added later.`,
          },
          {
            name: `\u23f3 ${MEDIA_RANK_EXPIRATION_DAYS} day Media Rank expiry`,
            value: `Media Rank roles now expire ${MEDIA_RANK_EXPIRATION_DAYS} days after they are granted. Expirations are stored in a SQLite database, so they survive restarts, crashes and redeploys - anything that lapsed while the bot was offline is cleaned up the moment it comes back. Expired members get a DM pointing them at ${channelMention(MEDIA_RENEWAL_CHANNEL_ID)} to renew.`,
          },
          {
            name: '\ud83d\udd28 Ban report details',
            value: 'Ban action reports now record who issued the ban and the banned user\'s username, so a report still identifies them when the mention only resolves to an id or "unknown user". Automatic spam trap bans are credited to the bot.',
          },
          {
            name: '\ud83c\udfab Ticket type routing',
            value: 'Ticket commands now read from one structured ticket type registry, and refusal messages list the ticket types each command actually applies to instead of hardcoding them.',
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
            value: 'Announces a recording event with an @everyone ping: time till event (Discord relative timestamp), IP, version, the amount of players needed and the `author` the recording is for, shown as "<display name> is RECORDING!". When the timer runs out the bot automatically posts a second `RECORDING EVENT LIVE` announcement. The `test` option sends both messages without pinging anyone.',
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

    if (interaction.commandName === 'scene') {
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

      const sceneName = interaction.options.getString('name', true).trim();
      const episode = interaction.options.getString('episode', true).trim();
      const director = interaction.options.getUser('director') ?? interaction.user;
      const deadline = interaction.options.getString('deadline')?.trim() || null;
      const scriptAttachment = interaction.options.getAttachment('script');

      if (!sceneName) {
        await interaction.reply({
          content: 'The scene name cannot be empty.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!isSceneStoreReady()) {
        await interaction.reply({
          content: 'Scene storage is unavailable right now, so I cannot open a scene ticket. Try again shortly.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Validated before anything is created so a bad upload never leaves an
      // orphaned ticket behind.
      const scriptCheck = validateSceneScript(scriptAttachment, interaction.guild);
      if (!scriptCheck.ok) {
        await interaction.reply({
          content: scriptCheck.reason,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let sceneCategory = interaction.guild.channels.cache.get(SCENE_CATEGORY_ID) ?? null;
      if (!sceneCategory) {
        sceneCategory = await interaction.guild.channels.fetch(SCENE_CATEGORY_ID).catch(() => null);
      }

      if (!sceneCategory || sceneCategory.type !== ChannelType.GuildCategory) {
        await interaction.editReply('Could not find the project category. Check the configured category ID.');
        return;
      }

      const permissionOverwrites = [
        {
          id: interaction.guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: director.id,
          allow: PROJECT_MEMBER_PERMISSIONS,
        },
      ];

      if (client.user?.id) {
        permissionOverwrites.push({
          id: client.user.id,
          allow: [
            ...PROJECT_MEMBER_PERMISSIONS,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageRoles,
            // Needed to pin the script message.
            PermissionFlagsBits.ManageMessages,
          ],
        });
      }

      let sceneChannel = null;
      try {
        sceneChannel = await interaction.guild.channels.create({
          name: getUniqueSceneChannelName(interaction.guild, sceneName),
          type: ChannelType.GuildText,
          parent: sceneCategory.id,
          topic: `${SCENE_TOPIC_PREFIX}${director.id}:status:open`,
          permissionOverwrites,
          reason: `Scene ticket "${sceneName}" created by ${interaction.user.tag}`,
        });
      } catch (error) {
        console.error('Failed to create scene channel:', error);
        await interaction.editReply('Failed to create the scene channel. Check my permissions and the category ID.');
        return;
      }

      const statusNotes = [];

      try {
        createScene({
          channelId: sceneChannel.id,
          guildId: interaction.guild.id,
          name: sceneName,
          episode,
          deadline,
          directorId: director.id,
          createdBy: interaction.user.id,
          scriptFileName: scriptCheck.attachment?.name ?? null,
        });
      } catch (error) {
        console.error(
          `CRITICAL: created scene channel ${sceneChannel.id} but could not persist its details. ` +
          '/cast and /callsheet will not work for it:',
          error,
        );
        statusNotes.push('\u26a0\ufe0f The scene details could not be saved, so `/cast` and `/callsheet` will not work in it. Delete the channel and try again once storage is healthy.');
      }

      try {
        await sceneChannel.send({
          content: `<@${director.id}>`,
          embeds: [
            buildSceneDetailsEmbed({
              sceneName,
              episode,
              director: director.id,
              deadline,
              scriptFileName: scriptCheck.attachment?.name ?? null,
              createdByTag: interaction.user.tag,
            }),
          ],
          allowedMentions: { users: [director.id] },
        });
      } catch (error) {
        console.error('Failed to send scene details embed:', error);
      }

      if (scriptCheck.attachment) {
        try {
          // Re-uploaded rather than linked: Discord CDN attachment URLs are
          // signed and expire, so the channel needs its own copy.
          const scriptMessage = await sceneChannel.send({
            content: '\ud83d\udcc4 **Scene script**',
            files: [{ attachment: scriptCheck.attachment.url, name: scriptCheck.attachment.name }],
          });

          await scriptMessage.pin().catch((error) => {
            console.error('Failed to pin the scene script message:', error);
          });
        } catch (error) {
          console.error('Failed to post the scene script:', error);
          statusNotes.push('\u26a0\ufe0f The script could not be posted. Upload it in the channel by hand.');
        }
      }

      const sceneLogEmbed = new EmbedBuilder()
        .setTitle('Action Report - Scene Ticket Created')
        .setDescription(truncateForEmbed(
          [
            `**Scene Name:** ${sceneName}`,
            `**Channel:** ${sceneChannel} (${sceneChannel.id})`,
            `**Created By:** <@${interaction.user.id}> (${interaction.user.id})`,
            `**Scene Director:** <@${director.id}> (${director.id})`,
            '',
            '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
            `**Episode / Chapter:** ${episode}`,
            `**Deadline:** ${deadline || 'Not specified.'}`,
            `**Script:** ${scriptCheck.attachment?.name || 'Not attached.'}`,
          ].join('\n'),
          4096,
        ))
        .setColor(0x242429)
        .setTimestamp();

      await sendAlertChannelEmbed(interaction.guild, sceneLogEmbed);

      await interaction.editReply([`Scene ticket created: ${sceneChannel}`, ...statusNotes].join('\n'));
      return;
    }

    if (interaction.commandName === 'cast') {
      if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used inside a server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!isSceneChannel(interaction.channel)) {
        await interaction.reply({
          content: 'This command can only be used inside a scene ticket channel.',
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

      if (!isSceneStoreReady()) {
        await interaction.reply({
          content: 'Scene storage is unavailable right now, so I cannot do that. Try again shortly.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const targetUser = interaction.options.getUser('user', true);
      const roleName = interaction.options.getString('role', true).trim();

      if (!roleName) {
        await interaction.reply({
          content: 'The part cannot be empty.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply();

      const scene = getScene(interaction.channelId);
      if (!scene) {
        await interaction.editReply('I have no record of this scene, so I cannot track its cast. It may have been created before the scene system existed.');
        return;
      }

      let targetMember = null;
      try {
        targetMember = await interaction.guild.members.fetch(targetUser.id);
      } catch (error) {
        console.error('Failed to fetch member for /cast:', error);
        await interaction.editReply('That user is not a member of this server.');
        return;
      }

      // Access first: if the row write then fails, they still have the channel
      // and the failure is loud, rather than a cast entry for someone locked out.
      try {
        await interaction.channel.permissionOverwrites.edit(
          targetMember.id,
          PROJECT_MEMBER_PERMISSION_OVERWRITE,
          { reason: `Cast in this scene by ${interaction.user.tag}` },
        );
      } catch (error) {
        console.error('Failed to grant scene channel access:', error);
        await interaction.editReply('Failed to give that user access to this ticket. Check my permissions. Nobody was cast.');
        return;
      }

      let castResult = null;
      try {
        castResult = setCastMember({
          channelId: interaction.channelId,
          guildId: interaction.guild.id,
          userId: targetMember.id,
          roleName,
          addedBy: interaction.user.id,
        });
      } catch (error) {
        console.error(
          `CRITICAL: gave ${targetMember.id} access to scene ${interaction.channelId} but could not record the cast entry:`,
          error,
        );
        await interaction.editReply(`Gave <@${targetMember.id}> access, but the cast entry could not be saved, so they will not show on the call sheet.`);
        return;
      }

      const statusNotes = [];
      try {
        await targetMember.send({
          embeds: [
            buildCastDMEmbed({
              sceneName: scene.name,
              roleName,
              episode: scene.episode,
              channelId: interaction.channelId,
            }),
          ],
        });
      } catch (error) {
        console.error('Failed to DM a newly cast member:', error);
        statusNotes.push('\u26a0\ufe0f Their DMs are closed, so they were not notified.');
      }

      const castLine = castResult.wasUpdate ?
        `Recast <@${targetMember.id}> as **${truncateForEmbed(roleName, 200)}** (was **${truncateForEmbed(castResult.previousRoleName, 200)}**).` :
        `Cast <@${targetMember.id}> as **${truncateForEmbed(roleName, 200)}**.`;

      await interaction.editReply({
        content: [castLine, ...statusNotes].join('\n'),
        allowedMentions: { users: [targetMember.id] },
      });
      return;
    }

    if (interaction.commandName === 'uncast') {
      if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used inside a server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!isSceneChannel(interaction.channel)) {
        await interaction.reply({
          content: 'This command can only be used inside a scene ticket channel.',
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

      if (!isSceneStoreReady()) {
        await interaction.reply({
          content: 'Scene storage is unavailable right now, so I cannot do that. Try again shortly.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const targetUser = interaction.options.getUser('user', true);

      await interaction.deferReply();

      let removedCastMember = null;
      try {
        removedCastMember = removeCastMember(interaction.channelId, targetUser.id);
      } catch (error) {
        console.error('Failed to remove a cast entry:', error);
        await interaction.editReply('Could not read the cast for this scene. Nobody was removed.');
        return;
      }

      if (!removedCastMember) {
        await interaction.editReply(`<@${targetUser.id}> is not in this scene's cast.`);
        return;
      }

      const statusNotes = [];
      // The director keeps access to their own scene even when they were cast in
      // a part, so uncasting them never locks them out.
      const directorId = getApplicantIdFromChannel(interaction.channel);

      if (targetUser.id === directorId) {
        statusNotes.push('They are the scene director, so they keep access to the channel.');
      } else {
        try {
          await interaction.channel.permissionOverwrites.delete(
            targetUser.id,
            `Removed from the cast by ${interaction.user.tag}`,
          );
        } catch (error) {
          console.error('Failed to revoke scene channel access:', error);
          statusNotes.push('\u26a0\ufe0f I could not revoke their channel access, so remove it by hand.');
        }
      }

      await interaction.editReply({
        content: [
          `Removed <@${targetUser.id}> from the cast (was **${truncateForEmbed(removedCastMember.role_name, 200)}**).`,
          ...statusNotes,
        ].join('\n'),
        allowedMentions: { users: [targetUser.id] },
      });
      return;
    }

    if (interaction.commandName === 'callsheet') {
      if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used inside a server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!isSceneChannel(interaction.channel)) {
        await interaction.reply({
          content: 'This command can only be used inside a scene ticket channel.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!isSceneStoreReady()) {
        await interaction.reply({
          content: 'Scene storage is unavailable right now, so I cannot do that. Try again shortly.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply();

      const scene = getScene(interaction.channelId);
      if (!scene) {
        await interaction.editReply('I have no record of this scene, so there is no call sheet for it.');
        return;
      }

      let castMembers = [];
      try {
        castMembers = listCast(interaction.channelId);
      } catch (error) {
        console.error('Failed to read the scene cast:', error);
        await interaction.editReply('Could not read the cast for this scene.');
        return;
      }

      const castLines = [];
      for (const castMember of castMembers) {
        // A departed actor should still read as a name rather than a broken mention.
        let label = `<@${castMember.user_id}>`;
        try {
          await interaction.guild.members.fetch(castMember.user_id);
        } catch (error) {
          let departedUser = null;
          try {
            departedUser = await client.users.fetch(castMember.user_id);
          } catch (fetchError) {
            departedUser = null;
          }

          label = `${formatUserLabel(departedUser)} (left the server)`;
        }

        castLines.push(`\u2022 ${label} \u2014 **${truncateForEmbed(castMember.role_name, 200)}**`);
      }

      await interaction.editReply({
        embeds: [buildCallsheetEmbed({ scene, castLines, castCount: castMembers.length })],
        allowedMentions: { parse: [] },
      });
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
          content: isSceneChannel(interaction.channel) ?
            'This is a scene ticket. Use `/cast` instead, so the part they are playing gets recorded.' :
            'This command can only be used inside a project (builder) ticket channel.',
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
      const eventAuthor = interaction.options.getUser('author', true);
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

      // Prefer the server display name (nickname), falling back to the global
      // display name; never the raw username.
      let eventAuthorName = eventAuthor.displayName;
      let eventAuthorIconURL = eventAuthor.displayAvatarURL();
      try {
        const eventAuthorMember = await interaction.guild.members.fetch(eventAuthor.id);
        eventAuthorName = eventAuthorMember.displayName;
        eventAuthorIconURL = eventAuthorMember.displayAvatarURL();
      } catch (error) {
        console.error('Failed to resolve the recording author member, using their global display name:', error);
      }

      const buildEventPayload = (isLive) => {
        const payload = {
          embeds: [
            buildEventEmbed({
              isLive,
              startTimestampSeconds,
              ip: eventIp,
              version: eventVersion,
              players: playersNeeded,
              authorName: eventAuthorName,
              authorIconURL: eventAuthorIconURL,
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

    if (interaction.commandName === 'exec') {
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

      const executionType = interaction.options.getString('type', true);
      const tierKey = interaction.options.getString('tier', true);
      const shouldAnnounce = interaction.options.getBoolean('announce', true);

      if (executionType !== 'media') {
        await interaction.reply({
          content: 'That execution type is not supported yet.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const ticketType = getTicketTypeFromChannel(interaction.channel);
      if (!ticketType?.supportsExec) {
        await interaction.reply({
          content: 'This command can only be used inside a media ticket.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const tier = MEDIA_TIERS[tierKey];
      if (!tier) {
        await interaction.reply({
          content: 'That media tier is not available.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // The applicant always comes from the ticket itself, never from an argument.
      const applicantId = getApplicantIdFromChannel(interaction.channel);
      if (!applicantId) {
        await interaction.reply({
          content: 'Could not resolve the applicant from this ticket.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // 1. Validate the member, the role and the bot's ability to grant it.
      let applicantMember = null;
      try {
        applicantMember = await interaction.guild.members.fetch(applicantId);
      } catch (error) {
        console.error('Failed to fetch the media applicant for /exec:', error);
        await interaction.editReply('Could not find the applicant in this server. No role was granted.');
        return;
      }

      let role = interaction.guild.roles.cache.get(tier.roleId) ?? null;
      if (!role) {
        role = await interaction.guild.roles.fetch(tier.roleId).catch(() => null);
      }

      if (!role) {
        await interaction.editReply(`The ${tier.name} role could not be found. No role was granted.`);
        return;
      }

      if (!canBotAssignRole(interaction.guild, role)) {
        await interaction.editReply(
          `I cannot assign **${role.name}**. Check that I have Manage Roles and that my highest role sits above it. No role was granted.`,
        );
        return;
      }

      // 2. Grant the Discord role.
      try {
        await applicantMember.roles.add(role, `Media Rank granted by ${interaction.user.tag}`);
      } catch (error) {
        console.error('Failed to grant the media rank role:', error);
        await interaction.editReply('Failed to grant the role. Check my permissions and role hierarchy. No role was granted.');
        return;
      }

      // 3. Persist the expiration so it survives restarts.
      const statusNotes = [];
      let expiresAt = null;
      try {
        ({ expiresAt } = grantTemporaryRole({
          guildId: interaction.guild.id,
          userId: applicantId,
          roleId: tier.roleId,
          durationMs: MEDIA_RANK_DURATION_MS,
        }));
      } catch (error) {
        console.error(
          `CRITICAL: granted ${tier.name} (${tier.roleId}) to ${applicantId} in guild ${interaction.guild.id} ` +
          'but could not persist its expiration. The role is currently untracked and will NOT expire automatically:',
          error,
        );
        statusNotes.push(
          '\u26a0\ufe0f The expiration could not be saved, so this role is **untracked** and will not expire on its own. Remove it manually or re-run once storage is healthy.',
        );
      }

      // 4. Acceptance DM, only after the role actually landed.
      const acceptanceEmbed = buildMediaAcceptanceEmbed({ tier, displayName: applicantMember.displayName });
      try {
        await applicantMember.send({
          content: `${userMention(applicantId)}`,
          embeds: [acceptanceEmbed],
          allowedMentions: { users: [applicantId] },
        });
      } catch (error) {
        console.error('Failed to DM the media acceptance embed:', error);
        statusNotes.push('\u26a0\ufe0f Their DMs are closed, so the acceptance message could not be delivered.');
      }

      // 5. Optional public announcement.
      if (shouldAnnounce) {
        const announcementChannel = await resolveGuildTextChannel(interaction.guild, MEDIA_ANNOUNCEMENT_CHANNEL_ID);
        if (announcementChannel) {
          try {
            await announcementChannel.send({
              content: `${roleMention(MEDIA_ANNOUNCEMENT_ROLE_ID)}`,
              embeds: [buildMediaAnnouncementEmbed({ applicantId, tier })],
              allowedMentions: { roles: [MEDIA_ANNOUNCEMENT_ROLE_ID] },
            });
          } catch (error) {
            console.error('Failed to send the media rank announcement:', error);
            statusNotes.push('\u26a0\ufe0f The announcement could not be posted.');
          }
        } else {
          statusNotes.push('\u26a0\ufe0f The announcement channel could not be resolved.');
        }
      }

      const expirySummary = expiresAt ?
        `It expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>.` :
        'Its expiration is not being tracked.';

      await interaction.editReply(
        [`Granted **${tier.name}** to <@${applicantId}>. ${expirySummary}`, ...statusNotes].join('\n'),
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
        bannedUserLabel: formatUserLabel(userToBan),
        reason,
        banTag,
        issuedByLabel: formatUserLabel(interaction.user),
        issuedById: interaction.user.id,
      });

      await sendAlertChannelEmbed(interaction.guild, banReportEmbed);

      await interaction.editReply(`Ban executed for **${userToBan.tag}** (${userIdToBan}). Ban ID: ${banTag}`);
      return;
    }
  }

  if (interaction.isButton() && [APPLY_BUTTON_ID, LEGACY_APPLY_BUTTON_ID].includes(interaction.customId)) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: 'Applications can only be started inside the server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isApplicationStoreReady()) {
      await interaction.reply({
        content: 'Applications are unavailable right now. Please try again shortly.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const existingChannel = findExistingTrustedApplicationChannel(interaction.guild, interaction.user.id);
    if (existingChannel) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `You already have an open Trusted application channel: ${existingChannel}`,
      });
      return;
    }

    const activeBlock = getApplicantBlock(interaction.guild.id, interaction.user.id);
    if (activeBlock) {
      const retryAt = Math.floor(new Date(activeBlock.expires_at).getTime() / 1000);
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `Your last Trusted application was not successful. You can apply again <t:${retryAt}:R>.`,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const usernamePart = sanitizeChannelPart(interaction.user.username).slice(0, 94);
    const channelName = getUniqueTrustedChannelName(interaction.guild, usernamePart);
    const auditionTest = pickAuditionTest();

    let applicationChannel = null;
    try {
      const permissionOverwrites = [
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
      ];

      if (client.user?.id) {
        // ManageMessages is what lets the bot purge the channel on submission.
        permissionOverwrites.push({
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.ManageChannels,
          ],
        });
      }

      applicationChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `${TRUSTED_TOPIC_PREFIX}${interaction.user.id}:status:open`,
        permissionOverwrites,
        reason: `Trusted application started by ${interaction.user.tag}`,
      });
    } catch (error) {
      console.error('Failed to create Trusted application channel:', error);
      await interaction.editReply('I could not create your application channel. Check my channel permissions.');
      return;
    }

    let application = null;
    try {
      application = createApplication({
        channelId: applicationChannel.id,
        guildId: interaction.guild.id,
        applicantId: interaction.user.id,
        applicantTag: formatUserLabel(interaction.user),
        reference: generateApplicationReference(),
        auditionKey: auditionTest.key,
      });
    } catch (error) {
      console.error('Failed to start a Trusted application record:', error);
      await applicationChannel.delete('Trusted application could not be started.').catch(() => null);
      await interaction.editReply('I could not start your application. Please try again shortly.');
      return;
    }

    await applicationChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('\ud83c\udfad Trusted Application')
          .setDescription([
            `Hey <@${interaction.user.id}>, thanks for applying for **Trusted** in our series!`,
            '',
            `I will ask you **${TRUSTED_APPLICATION_QUESTIONS.length} questions**, one at a time. Just reply in this channel and your next message is recorded as the answer.`,
            '',
            'At the end you can review everything and change any answer before it goes to our team.',
          ].join('\n'))
          .setColor(0x242429)
          .setFooter({ text: `${application.reference} \u2022 Please do not ping anyone until we review your application.` }),
      ],
      allowedMentions: { users: [interaction.user.id] },
    });

    await postTrustedQuestion(applicationChannel, application, 0);

    await interaction.editReply(`Your application has started in ${applicationChannel}.`);
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

  // -------------------------------------------- Trusted application review
  if (
    interaction.isButton() &&
    [TRUSTED_APP_DONE_ID, LEGACY_TRUSTED_APP_DONE_ID, TRUSTED_APP_EDIT_ID, LEGACY_TRUSTED_APP_EDIT_ID]
      .includes(interaction.customId)
  ) {
    if (!isApplicationStoreReady()) {
      await interaction.reply({ content: 'Applications are unavailable right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    const application = getApplication(interaction.channelId);
    if (!application) {
      await interaction.reply({ content: 'I have no record of this application.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.user.id !== application.applicant_id) {
      await interaction.reply({ content: 'Only the applicant can use these buttons.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (application.status !== APPLICATION_STATUS.review) {
      await interaction.reply({ content: 'This application is not waiting for review right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    if ([TRUSTED_APP_EDIT_ID, LEGACY_TRUSTED_APP_EDIT_ID].includes(interaction.customId)) {
      const editSelect = new StringSelectMenuBuilder()
        .setCustomId(TRUSTED_APP_EDIT_SELECT_ID)
        .setPlaceholder('Which answer do you want to change?')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          TRUSTED_APPLICATION_QUESTIONS.map((question, index) => ({
            label: question.label,
            value: String(index),
            emoji: question.emoji,
          })),
        );

      await interaction.reply({
        content: 'Pick the answer you want to redo.',
        components: [new ActionRowBuilder().addComponents(editSelect)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Done - take the review buttons away first so it cannot be double submitted.
    await interaction.deferUpdate();
    await interaction.message.edit({ components: [] }).catch(() => null);

    try {
      await submitTrustedApplication(interaction.channel, application);
    } catch (error) {
      console.error('Failed to submit a Trusted application:', error);
      await interaction.followUp({
        content: 'Something went wrong submitting your application. Please tell a staff member.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
    }
    return;
  }

  if (
    interaction.isStringSelectMenu() &&
    [TRUSTED_APP_EDIT_SELECT_ID, LEGACY_TRUSTED_APP_EDIT_SELECT_ID].includes(interaction.customId)
  ) {
    if (!isApplicationStoreReady()) {
      await interaction.reply({ content: 'Applications are unavailable right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    const application = getApplication(interaction.channelId);
    if (!application || interaction.user.id !== application.applicant_id) {
      await interaction.reply({ content: 'Only the applicant can change these answers.', flags: MessageFlags.Ephemeral });
      return;
    }

    const stepIndex = Number.parseInt(interaction.values[0], 10);
    const question = TRUSTED_APPLICATION_QUESTIONS[stepIndex];
    if (!question) {
      await interaction.reply({ content: 'That is not one of the questions.', flags: MessageFlags.Ephemeral });
      return;
    }

    const editing = setApplicationState(interaction.channelId, {
      status: APPLICATION_STATUS.inProgress,
      currentStep: stepIndex,
      editingStep: stepIndex,
    });

    await interaction.update({
      content: `Reply in the channel with your new answer for **${question.label}**.`,
      components: [],
    });

    await postTrustedQuestion(interaction.channel, editing, stepIndex);
    return;
  }

  // ----------------------------------------- Trusted application decisions
  if (
    interaction.isButton() &&
    [TRUSTED_APP_ACCEPT_ID, LEGACY_TRUSTED_APP_ACCEPT_ID, TRUSTED_APP_REJECT_ID, LEGACY_TRUSTED_APP_REJECT_ID]
      .some((prefix) => interaction.customId.startsWith(`${prefix}:`))
  ) {
    if (!isAuthorized(interaction)) {
      await interaction.reply({
        content: 'You need administrator permissions to decide applications.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const isAccept = [TRUSTED_APP_ACCEPT_ID, LEGACY_TRUSTED_APP_ACCEPT_ID]
      .some((prefix) => interaction.customId.startsWith(`${prefix}:`));
    const buttonApplicantId = interaction.customId.slice(interaction.customId.indexOf(':') + 1);
    const topicApplicantId = getApplicantIdFromChannel(interaction.channel);

    // The button carries the id, but the channel topic is the authority.
    if (!topicApplicantId || topicApplicantId !== buttonApplicantId) {
      await interaction.reply({
        content: 'This button does not match the applicant on this ticket.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Disable immediately so a second click cannot double-decide.
    await interaction.message.edit({ components: [] }).catch(() => null);

    const application = isApplicationStoreReady() ? getApplication(interaction.channelId) : null;
    const reference = application?.reference ?? 'Unknown';
    const applicantLabel = application?.applicant_tag ?? 'Unknown';
    const statusNotes = [];

    if (isAccept) {
      let role = interaction.guild.roles.cache.get(TRUSTED_ROLE_ID) ?? null;
      if (!role) {
        role = await interaction.guild.roles.fetch(TRUSTED_ROLE_ID).catch(() => null);
      }

      if (!role) {
        await interaction.editReply('The Trusted role could not be found. Nothing was changed.');
        await interaction.message.edit({ components: buildTrustedDecisionComponents(topicApplicantId) }).catch(() => null);
        return;
      }

      if (!canBotAssignRole(interaction.guild, role)) {
        await interaction.editReply(`I cannot assign **${role.name}**. Check Manage Roles and my role position. Nothing was changed.`);
        await interaction.message.edit({ components: buildTrustedDecisionComponents(topicApplicantId) }).catch(() => null);
        return;
      }

      let applicantMember = null;
      try {
        applicantMember = await interaction.guild.members.fetch(topicApplicantId);
      } catch (error) {
        console.error('Failed to fetch the applicant on accept:', error);
        await interaction.editReply('The applicant is no longer in this server. Nothing was changed.');
        return;
      }

      try {
        await applicantMember.roles.add(role, `Trusted application accepted by ${interaction.user.tag}`);
      } catch (error) {
        console.error('Failed to grant the Trusted role:', error);
        await interaction.editReply('Failed to grant the Trusted role. Nothing was changed.');
        await interaction.message.edit({ components: buildTrustedDecisionComponents(topicApplicantId) }).catch(() => null);
        return;
      }

      try {
        await applicantMember.send({ embeds: [buildAcceptanceEmbed(topicApplicantId, 'Trusted')] });
      } catch (error) {
        console.error('Failed to DM the accepted applicant:', error);
        statusNotes.push('\u26a0\ufe0f Their DMs are closed, so they were not notified.');
      }
    } else {
      try {
        const applicantMember = await interaction.guild.members.fetch(topicApplicantId);
        await applicantMember.send('Your Trusted application in Island SMP has been rejected. Thank you for your interest!');
      } catch (error) {
        console.error('Failed to DM the rejected applicant:', error);
        statusNotes.push('\u26a0\ufe0f Their DMs are closed, so they were not notified.');
      }

      try {
        blockApplicant({
          guildId: interaction.guild.id,
          userId: topicApplicantId,
          reason: `Trusted application rejected by ${interaction.user.tag}`,
          durationMs: TRUSTED_REAPPLY_COOLDOWN_MS,
        });
      } catch (error) {
        console.error('Failed to record the Trusted re-apply cooldown:', error);
        statusNotes.push('\u26a0\ufe0f The re-apply cooldown could not be saved.');
      }
    }

    const outcomeEmbed = new EmbedBuilder()
      .setTitle(`Action Report - Trusted Application ${isAccept ? 'Accepted' : 'Rejected'}`)
      .setDescription(truncateForEmbed([
        `**Reference:** ${reference}`,
        `**Applicant:** <@${topicApplicantId}> (${topicApplicantId})`,
        `**Username:** ${applicantLabel}`,
        `**Decided By:** <@${interaction.user.id}> \u2013 \`${formatUserLabel(interaction.user)}\``,
        ...(isAccept ? [] : [`**Can reapply:** <t:${Math.floor((Date.now() + TRUSTED_REAPPLY_COOLDOWN_MS) / 1000)}:R>`]),
      ].join('\n'), 4096))
      .setColor(isAccept ? 0x2ECC71 : 0xFF0000)
      .setTimestamp();

    await sendAlertChannelEmbed(interaction.guild, outcomeEmbed);

    await interaction.editReply([
      `${isAccept ? 'Accepted' : 'Rejected'} <@${topicApplicantId}> (${reference}). Closing the ticket.`,
      ...statusNotes,
    ].join('\n'));

    try {
      await interaction.guild.channels.delete(interaction.channelId, `Trusted application ${isAccept ? 'accepted' : 'rejected'} by ${interaction.user.tag}`);
    } catch (error) {
      console.error('Failed to delete the decided application channel:', error);
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === MEDIA_BUTTON_ID) {
    // A select menu cannot live inside a modal, so the tier is chosen first and
    // then carried into the modal through its custom id.
    const tierSelect = new StringSelectMenuBuilder()
      .setCustomId(MEDIA_TIER_SELECT_ID)
      .setPlaceholder('Select the media rank you are applying for')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        Object.values(MEDIA_TIERS).map((tier) => ({
          label: tier.applicationLabel,
          value: tier.key,
          emoji: tier.emoji,
        })),
      );

    await interaction.reply({
      content: '\ud83c\udfac Which media rank are you applying for?',
      components: [new ActionRowBuilder().addComponents(tierSelect)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === MEDIA_TIER_SELECT_ID) {
    const selectedTier = MEDIA_TIERS[interaction.values[0]];

    if (!selectedTier) {
      await interaction.reply({
        content: 'That media rank is not available. Please try again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`${MEDIA_MODAL_ID}:${selectedTier.key}`)
      .setTitle(`${selectedTier.applicationLabel} Application`.slice(0, 45));

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
      .setMaxLength(3);

    const videoInput = new TextInputBuilder()
      .setCustomId('applicant_video')
      .setLabel("Link for the video you're applying with")
      .setPlaceholder('https://...')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(500);

    const notesInput = new TextInputBuilder()
      .setCustomId('applicant_notes')
      .setLabel('Additional notes')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(1000);

    modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(ageInput),
        new ActionRowBuilder().addComponents(videoInput),
        new ActionRowBuilder().addComponents(notesInput),
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
        content: `You already have an open builder application channel: ${existingChannel}`,
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
  if (interaction.isModalSubmit() && interaction.customId.startsWith(`${MEDIA_MODAL_ID}:`)) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'This form can only be submitted inside a server.',
      });
      return;
    }

    const tier = MEDIA_TIERS[interaction.customId.slice(MEDIA_MODAL_ID.length + 1)];
    if (!tier) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'That media rank is not available. Please start a new application.',
      });
      return;
    }

    const name = interaction.fields.getTextInputValue('applicant_name').trim();
    const age = interaction.fields.getTextInputValue('applicant_age').trim();
    const videoUrl = interaction.fields.getTextInputValue('applicant_video').trim();
    const notes = interaction.fields.getTextInputValue('applicant_notes').trim();

    // Server side validation: the modal's own constraints are not trusted.
    if (!name) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Please provide your name.' });
      return;
    }

    const parsedAge = Number.parseInt(age, 10);
    if (!/^\d{1,3}$/.test(age) || !Number.isInteger(parsedAge) || parsedAge < 13 || parsedAge > 120) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'Please provide a valid age between 13 and 120.',
      });
      return;
    }

    let parsedVideoUrl = null;
    try {
      parsedVideoUrl = new URL(videoUrl);
    } catch (error) {
      parsedVideoUrl = null;
    }

    if (!parsedVideoUrl || !['http:', 'https:'].includes(parsedVideoUrl.protocol)) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'Please provide a valid video link starting with `http://` or `https://`.',
      });
      return;
    }

    const existingChannel = findExistingMediaTicketChannel(interaction.guild, interaction.user.id);
    if (existingChannel) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `You already have an open media application channel: ${existingChannel}`,
      });
      return;
    }

    const usernamePart = sanitizeChannelPart(interaction.user.username).slice(0, 94);
    const channelName = getUniqueMediaChannelName(interaction.guild, usernamePart);

    try {
      const applicationChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `${MEDIA_TOPIC_PREFIX}${interaction.user.id}:status:open:tier:${tier.key}`,
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
        reason: `Media application submitted by ${interaction.user.tag}`,
      });

      const applicationEmbed = buildMediaApplicationEmbed({
        applicantId: interaction.user.id,
        name,
        age,
        videoUrl,
        tier,
        notes,
      });

      await applicationChannel.send({
        content: `${userMention(MEDIA_REVIEWER_USER_ID)}`,
        embeds: [applicationEmbed],
        allowedMentions: { users: [MEDIA_REVIEWER_USER_ID] },
      });
      await applicationChannel.send({
        content: `Hey there <@${interaction.user.id}>!\n\nThanks for applying for the **${tier.name}**!\n\n` +
          'Please post your proof of views here so our team can review your application.',
      });

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `Thanks for applying, ${name}! I created ${applicationChannel} for your media application.`,
      });
    } catch (error) {
      console.error('Failed to create media application channel:', error);
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'Your form was received, but I could not create the channel. Check my channel permissions.',
      });
    }
    return;
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
        content: `Could not find applicant ID. Make sure this command is run in a ${describeTicketTypesFor('supportsAccept')} application channel.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const ticketType = getTicketTypeFromChannel(interaction.channel);

    if (!ticketType?.supportsAccept) {
      await interaction.reply({
        content: `This command can only be used in ${describeTicketTypesFor('supportsAccept')} application channels.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const roleId = ticketType.acceptRoleId;
    const programLabel = ticketType.label;
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
    const ticketType = getTicketTypeFromChannel(interaction.channel);

    if (!applicantId) {
      await interaction.reply({
        content: 'Could not find applicant ID. Make sure this command is run in an application channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!ticketType?.supportsReject) {
      await interaction.reply({
        content: `This command can only be used in ${describeTicketTypesFor('supportsReject')} application channels.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: `Rejecting this ${ticketType.label} application and closing the ticket.`,
      flags: MessageFlags.Ephemeral,
    });

    try {
      const applicantMember = await interaction.guild.members.fetch(applicantId);
      const dmChannel = await applicantMember.createDM();
      await dmChannel.send(`Your ${ticketType.label} application in Island SMP has been rejected. Thank you for your interest!`);
    } catch (error) {
      console.error('Failed to send DM to applicant:', error);
    }

    try {
      await interaction.guild.channels.delete(interaction.channelId);
    } catch (error) {
      console.error('Failed to delete rejected application channel:', error);
    }
    return;
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
            { name:"How do I apply?", value:`${channelMention(HOW_APPLY_CHANNEL_ID)} is where you can apply for the Trusted role in our series! Click the button there and a private ticket opens for you.`},
            { name:"What happens after I apply?", value:"The bot asks you a few questions in your ticket, one at a time, and records each reply. Two of them need a short voice recording, so have a microphone ready. You get to review everything and change any answer before it goes to our team. Being accepted can take a day or two, depending on how our managers are."},
            { name:"What is the IP?", value:"This is not a public SMP. There is no IP to join, and you cannot play whenever you'd like. You can only play when we host recording events in order to contribute to our storyline. For more information, do /faq in #faq."}
        )
        .setColor(0x242429);

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral});
  }
});

client.on(Events.ChannelDelete, async (channel) => {
  // Keep the scene store from accumulating rows for channels that no longer exist.
  if (!channel?.id) {
    return;
  }

  try {
    const removed = deleteSceneData(channel.id);
    if (removed.sceneRemoved > 0 || removed.castRemoved > 0) {
      console.log(
        `Cleaned up scene data for deleted channel ${channel.id}: ${removed.sceneRemoved} scene, ${removed.castRemoved} cast entries.`,
      );
    }
  } catch (error) {
    console.error('Failed to clean up scene data for a deleted channel:', error);
  }

  try {
    if (isApplicationStoreReady() && deleteApplication(channel.id) > 0) {
      console.log(`Cleaned up the Trusted application for deleted channel ${channel.id}.`);
    }
  } catch (error) {
    console.error('Failed to clean up Trusted application data for a deleted channel:', error);
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
          bannedUserLabel: formatUserLabel(message.author),
          reason: ANTI_SPAM_BAN_REASON,
          banTag,
          issuedByLabel: 'Northstar Utils (automatic spam trap)',
        }),
      );
    } catch (error) {
      console.error('Failed to ban antispam trap user:', error);
    }
    return;
  }

  // Trusted application answers.
  //
  // This sits above every other trigger on purpose. The bot-mention branch below
  // returns for any non-owner, and message.mentions.users includes the
  // replied-to author - so an applicant replying to one of the bot's questions
  // would have their answer silently swallowed. The how/apply and how/join
  // triggers further down also lack a return and would fire on innocent answers.
  if (isTrustedApplicationChannel(message.channel) && isApplicationStoreReady()) {
    let application = null;
    try {
      application = getApplication(message.channel.id);
    } catch (error) {
      console.error('Failed to read a Trusted application while handling a message:', error);
      application = null;
    }

    const awaitingAnswer =
      application &&
      application.status === APPLICATION_STATUS.inProgress &&
      application.applicant_id === message.author.id &&
      Number.isInteger(application.current_step);

    if (awaitingAnswer) {
      const question = TRUSTED_APPLICATION_QUESTIONS[application.current_step];

      if (question) {
        const result = question.audio ?
          validateAudioAnswer(message, message.guild) :
          question.validate(message);

        if (!result.ok) {
          await message.reply({
            content: result.reason,
            allowedMentions: { parse: [] },
          }).catch((error) => console.error('Failed to send an answer correction:', error));
          return;
        }

        let answer = result.answer;

        // Audio is pulled down immediately: the messages holding it get purged
        // on submission and Discord CDN links expire.
        if (question.audio && result.attachment) {
          try {
            const buffer = await downloadAttachmentBuffer(result.attachment);
            saveApplicationMedia(message.channel.id, question.slot, buffer, result.attachment.name);
          } catch (error) {
            console.error('Failed to store an application voiceover:', error);
            await message.reply({
              content: 'I could not save that recording. Please try uploading it again.',
              allowedMentions: { parse: [] },
            }).catch(() => null);
            return;
          }
        } else if (question.audio) {
          // A link answer replaces any previously uploaded file for this slot.
          answer = { link: result.answer.link };
        }

        try {
          await advanceTrustedApplication(message.channel, application, question, answer);
        } catch (error) {
          console.error('Failed to advance a Trusted application:', error);
          await message.reply({
            content: 'Something went wrong recording that answer. Please try again.',
            allowedMentions: { parse: [] },
          }).catch(() => null);
        }

        return;
      }
    }
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

  // postactorembed is the pre-rename name, kept so muscle memory still works.
  if (normalizedContent === 'posttrustedembed' || normalizedContent === 'postactorembed') {
    if (message.author.id !== ALLOWED_USER_ID) return;
    await message.delete();

    const trustedEmbed = new EmbedBuilder()
        .setTitle('🎭 Trusted Applications')
        .setDescription('Open a ticket to apply for the Trusted role in our series.\n------------------------------------------------')
        .setColor(0x242429)
        .addFields(
            { name: 'Requirements', value: '➡️ **Be at least 16 years old.**\n➡️ Have a microphone.\n➡️ Speak fluent english.' },
            { name: 'What to expect', value: 'I will ask you a few questions in your ticket, one at a time. Two of them need a short voice recording, so have a microphone ready before you start.' },
        )
        .setFooter({ text: 'Click on the button below to begin your application!' });

    const trustedButtonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(APPLY_BUTTON_ID)
        .setLabel('Apply for Trusted')
        .setEmoji('🎭')
        .setStyle(ButtonStyle.Primary),
    );

    await message.channel.send({ embeds: [trustedEmbed], components: [trustedButtonRow] });
    return;
  }

  if (normalizedContent === 'postbuilderembed') {
    if (message.author.id !== ALLOWED_USER_ID) return;
    await message.delete();

    const builderEmbed = new EmbedBuilder()
        .setTitle('🪴 Builder Applications')
        .setDescription('Open a ticket to apply to become a Builder in our series.\n------------------------------------------------')
        .setColor(0x242429)
        .addFields(
            { name: 'Requirements', value: '➡️ Be able to show past builds.\n➡️ All work you submit must be your own.\n➡️ Speak fluent english.' },
        )
        .setFooter({ text: 'Click on the button below to begin your application!' });

    const builderButtonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
          .setCustomId(BUILDER_BUTTON_ID)
          .setLabel('Apply for Builder')
          .setEmoji('🪴')
          .setStyle(ButtonStyle.Secondary),
    );

    await message.channel.send({ embeds: [builderEmbed], components: [builderButtonRow] });
    return;
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

  if (normalizedContent === '~$postmediaembed') {
    if (message.author.id !== ALLOWED_USER_ID) return;

    try {
      await message.delete();
    } catch (error) {
      console.error('Failed to delete the ~$postmediaembed trigger message:', error);
    }

    const mediaButtonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(MEDIA_BUTTON_ID)
            .setLabel('Apply for Media')
            .setEmoji('\ud83c\udfa5')
            .setStyle(ButtonStyle.Primary),
    );

    await message.channel.send({
      embeds: [buildMediaRankEmbed()],
      components: [mediaButtonRow],
      allowedMentions: { parse: [] },
    });
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
        {content:`${channelMention(HOW_APPLY_CHANNEL_ID)} is where you can apply for the Trusted role in our series! Click the button there and a private ticket opens for you.`}
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
        .setDescription(`➡️ **What is Island SMP?**\nIsland SMP is a new scripted SMP content series which aims to bring cinematography and epicness to the Minecraft scene.\n\n➡️ **How do I apply?**\nGo to ${channelMention(HOW_APPLY_CHANNEL_ID)} and click the "Apply for Trusted" button. A private ticket opens for you.\n\n➡️ **What are the requirements?**\n- Be at least 16 years old.\n- Have a microphone.\n- Speak fluent English.\n\n➡️ **What happens after I apply?**\nThe bot asks you a few questions in your ticket, one at a time, and records each reply. Two of them need a short voice recording, so have a microphone ready. You get to review everything and change any answer before it goes to our team, and if you are accepted you receive the Trusted role and access to the member channels. Being accepted can take a day or two, depending on how our managers are.\n\n➡️ **Further Clarification**\nThis is not a public SMP. There is no IP to join, and you cannot play whenever you'd like. You can only play when we host recording events in order to contribute to our storyline. For more information, do /faq in ${channelMention('1156740100076617728')}.`)
        .setColor(0x242429);

    await message.delete();
    await message.channel.send({ embeds: [embed] });
  }
});

client.login(token);
