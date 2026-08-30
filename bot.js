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
  TextInputStyle, roleMention, channelMention, MessageFlagsBitField,
} = require('discord.js');
const cron = require('node-cron');

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('Missing DISCORD_TOKEN in .env file.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  cron.schedule(
    '30 14 * * *',
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
});

const APPLY_BUTTON_ID = 'actor_apply_open';
const BUILDER_BUTTON_ID = 'builder_apply_open'
const APPLY_MODAL_ID = 'actor_apply_form';
const BUILDER_MODAL_ID = 'builder_apply_form';
const ACTOR_TOPIC_PREFIX = 'actor-app:user:';
const BUILDER_TOPIC_PREFIX = 'builder-app:user:';
const ALLOWED_USER_ID = '1273910593539014680';
const CHAT_REVIVE_ROLE_ID = '1534150069593444402';
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
const BOT_PING_SEQUENCE = [
  '↻ System Check Init...',
  '✅ Quantum Carburator Operational...',
  '✅ Microverse Battery Operational...',
  '✅ Self-Destruction Protocol on Standby...',
  '✦ All systems operational.',
  '➲ Gravitron on Standby.',
];

function getRandomQuestion() {
  return CHAT_REVIVE_QUESTIONS[Math.floor(Math.random() * CHAT_REVIVE_QUESTIONS.length)];
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
    interaction.memberPermissions?.has('Administrator')
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

function getApplicantIdFromChannel(channel) {
  const channelTopic = channel?.topic || '';
  const topicMatch = channelTopic.match(new RegExp(`^${ACTOR_TOPIC_PREFIX}(\\d+)`)) || channelTopic.match(new RegExp(`^${BUILDER_TOPIC_PREFIX}(\\d+)`));

  return topicMatch ? topicMatch[1] : null;
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === 'ping') {
      await interaction.reply('Pong!');
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

  if (interaction.isModalSubmit() && interaction.customId === APPLY_MODAL_ID) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        ephemeral: true,
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
        ephemeral: true,
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
            {content:`${roleMention('1475116965457825936')}`, embeds: [appEmbed] }
      );
      await applicationChannel.send(
          {content:`Hey there <@${interaction.user.id}>!\n\nThanks for applying to become an Actor in our series!\n\n` +
                `In order to proceed with your application, please submit an audio file with you saying the following lines:\n`, embeds: [actEmbed] }
      )
      // await applicationChannel.send(
      //     {embeds: [actEmbed]}
      // )

      await interaction.reply({
        ephemeral: true,
        content: `Thanks for applying, ${name}! I created ${applicationChannel} for your application.`,
      });
    } catch (error) {
      console.error('Failed to create actor application channel:', error);
      await interaction.reply({
        ephemeral: true,
        content: 'Your form was received, but I could not create the channel. Check my channel permissions.',
      });
    }
  }

  // BUILDER LOGIC
  if (interaction.isModalSubmit() && interaction.customId === BUILDER_MODAL_ID) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        ephemeral: true,
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
        ephemeral: true,
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
          {content:`${roleMention('1475116965457825936')}`, embeds: [appEmbed] }
      );
      await applicationChannel.send(
          {content:`Hey there <@${interaction.user.id}>!\n\nThanks for applying to become a Builder in our series!\n\n` +
                `In order to proceed with your application, please submit a couple of images with your past builds.\n\n⚠️ **Please note that if any of the images submitted are stolen and not yours, you will be banned.**`}
      )
      // await applicationChannel.send(
      //     {embeds: [actEmbed]}
      // )

      await interaction.reply({
        ephemeral: true,
        content: `Thanks for applying, ${name}! I created ${applicationChannel} for your application.`,
      });
    } catch (error) {
      console.error('Failed to create builder application channel:', error);
      await interaction.reply({
        ephemeral: true,
        content: 'Your form was received, but I could not create the channel. Check my channel permissions.',
      });
    }
  }
  if(interaction.isChatInputCommand() && interaction.commandName === 'accept') {
    if (!isAuthorized(interaction)) {
      return;
    }
    try {
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

      const roleId = isActorChannel ? '1475102281753038858' : '1475102345854713977';
      const role = interaction.guild.roles.cache.get(roleId);
      
      if (!role) {
        await interaction.reply('Role not found. Check the role ID.');
        return;
      }

      const applicantMember = await interaction.guild.members.fetch(applicantId);
      await applicantMember.roles.add(role);
      
      const roleType = isActorChannel ? 'Actor' : 'Builder';
      await interaction.reply(`Congratulations <@${applicantId}>, your ${roleType} application in Island SMP has been accepted! Welcome to the team!\n\nPlease join this discord server: https://discord.gg/DRmd22gCCf`);
    } catch (error) {
      console.error('Failed to add role:', error);
      await interaction.reply('Failed to add role. Check my permissions.');
    }
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
      await interaction.reply('Could not find applicant ID. Make sure this command is run in an actor application channel.');
      return;
    }
    try {
      const applicantMember = await interaction.guild.members.fetch(applicantId);
      const dmChannel = await applicantMember.createDM();
      await dmChannel.send('Your ticket in Island SMP has been closed.');
      await interaction.guild.channels.delete(interaction.channelId);
    } catch (e) {
      console.error('Failed to send DM to applicant:', e);
    }

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

    await interaction.reply({ embeds: [embed], ephemeral:true});
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const normalizedContent = message.content.trim().toLowerCase();

  if (message.mentions.users.has(client.user.id)) {
    try {
      const statusMessage = await message.reply({ content: BOT_PING_SEQUENCE[0] });

      for (let i = 1; i < BOT_PING_SEQUENCE.length; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await statusMessage.edit(BOT_PING_SEQUENCE[i]);
      }
    } catch (error) {
      console.error('Failed to send bot ping status sequence:', error);
    }
    return;
  }

  if (message.author.id === ALLOWED_USER_ID && normalizedContent === 'yo gravitron make me sum to eat') {
    await message.reply('bro im a robot');
    return;
  }

  if (message.author.id === ALLOWED_USER_ID && normalizedContent === 'am i right gravitron?') {
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

  if (message.content.trim().toLowerCase() === '~$init protocol 41') {
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

  if (message.content.includes("how") && message.content.includes("apply")) {
    await message.reply(
        {content:`${channelMention('1156739680994328616')} is where you can apply to become an actor in our series! Just click the button there and fill out the form to start your application.`}
    );
  }
  if (message.content.includes("how") && message.content.includes("join")) {
    await message.reply(
        {content:`${channelMention('1485697198963294342')} is where you can find information about how to participate in our series!` }
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
