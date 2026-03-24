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
});

const APPLY_BUTTON_ID = 'actor_apply_open';
const APPLY_MODAL_ID = 'actor_apply_form';
const ACTOR_TOPIC_PREFIX = 'actor-app:user:';
const ALLOWED_USER_ID = '1273910593539014680';

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
  const base = `actor-${usernamePart}`.slice(0, 100);
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

function getApplicantIdFromChannel(channel) {
  const channelTopic = channel?.topic || '';
  const topicMatch = channelTopic.match(new RegExp(`^${ACTOR_TOPIC_PREFIX}(\\d+)`));

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
  if(interaction.isChatInputCommand() && interaction.commandName === 'accept') {
    if (!isAuthorized(interaction)) {
      return;
    }
    try {
      const role = interaction.guild.roles.cache.get('1475102281753038858');
      if (!role) {
        await interaction.reply('Role not found. Check the role ID.');
        return;
      }

      const applicantId = getApplicantIdFromChannel(interaction.channel);

      if (!applicantId) {
        await interaction.reply('Could not find applicant ID. Make sure this command is run in an actor application channel.');
        return;
      }

      const applicantMember = await interaction.guild.members.fetch(applicantId);
      await applicantMember.roles.add(role);
      await interaction.reply(`Congratulations <@${applicantId}>, your application in Island SMP has been accepted! Welcome to the team!\n\nPlease join this discord server: https://discord.gg/KNVmAkBPdf`);
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
      await interaction.reply('Could not find applicant ID. Make sure this command is run in an actor application channel.');
      return;
    }

    try {
      const applicantMember = await interaction.guild.members.fetch(applicantId);
      const dmChannel = await applicantMember.createDM();
      await dmChannel.send('Your application in Island SMP has been rejected. Thank you for your interest!');
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

  if (message.content.trim().toLowerCase() === 'app') {
    if (message.author.id !== ALLOWED_USER_ID) return;
    await message.delete();
    const embed = new EmbedBuilder()
        .setTitle('Actor Applications')
        .setDescription('Open a ticket to apply to become an Actor in our series.\n-----------------------------------------------------------')
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
        .setStyle(ButtonStyle.Success),
    );

    await message.channel.send({ embeds: [embed], components: [buttonRow] });
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

