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
  TextInputBuilder,
  TextInputStyle, roleMention,
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!isAuthorized(interaction)) {
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
    await interaction.reply('Pong!');
    return;
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
    try {
      const role = interaction.guild.roles.cache.get('1475102281753038858');
      if (!role) {
        await interaction.reply('Role not found. Check the role ID.');
        return;
      }
      
      await interaction.member.roles.add(role);
      await interaction.reply(`Congratulations <@${interaction.user.id}>, your application in Island SMP has been accepted! Welcome to the team!\n\nPlease join this discord server: https://discord.gg/KNVmAkBPdf`);
    } catch (error) {
      console.error('Failed to add role:', error);
      await interaction.reply('Failed to add role. Check my permissions.');
    }
  }
  if(interaction.isChatInputCommand() && interaction.commandName === 'reject') {
    await interaction.user.createDM().then(async (dmChannel) => {
      await dmChannel.send('Your application in Island SMP has been rejected. Thank you for your interest!');
    }).catch((error) => {
      console.error('Failed to send DM to user:', error);
    });
    await interaction.guild.channels.delete(interaction.channelId);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.author.id !== ALLOWED_USER_ID) return;

  if (message.content.trim().toLowerCase() === 'app') {
    await message.delete();
    const embed = new EmbedBuilder()
        .setTitle('Actor Applications')
        .setDescription('Open a ticket to apply to become an Actor in our series.\n-----------------------------------------------------------')
        .setColor(0x242429)
        .addFields(
            { name:"Requirements", value:"➡️ Be at least 16 years old.\n➡️ Have a microphone.\n➡️ Must be at least 16 years old.\n➡️ Speak fluent english. "}
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
});

client.login(token);

