require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env file.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with Pong!')
    .toJSON(),

  new SlashCommandBuilder()
      .setName('accept')
      .setDescription('Accept an actor application by providing the applicant\'s username.')
      .toJSON(),


  new SlashCommandBuilder()
      .setName('reject')
      .setDescription('Reject an actor application by providing the applicant\'s username.')
      .toJSON(),

  new SlashCommandBuilder()
      .setName('close')
      .setDescription('Close the applicant\'s ticket.')
      .toJSON(),

  new SlashCommandBuilder()
      .setName('faq')
      .setDescription('Display frequently asked questions.')
      .toJSON(),

  new SlashCommandBuilder()
      .setName('patchnotes')
      .setDescription('Display the latest Northstar Utils patch notes.')
      .toJSON(),

  new SlashCommandBuilder()
      .setName('membercount')
      .setDescription('Show total members and recent joins in the last 24 hours.')
      .toJSON(),

  new SlashCommandBuilder()
      .setName('ticketstats')
      .setDescription('Show open Northstar Utils ticket counts by type.')
      .toJSON(),

  new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a user by mention or ID with reason, duration, and message deletion options.')
      .addStringOption((option) =>
        option
          .setName('user')
          .setDescription('User mention or ID to ban.')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Reason for the ban.')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('How long the ban should last.')
          .setRequired(true)
          .addChoices(
            { name: '1 day', value: '1d' },
            { name: '2 days', value: '2d' },
            { name: '7 days', value: '7d' },
            { name: 'Permanently', value: 'permanent' },
          ),
      )
      .addBooleanOption((option) =>
        option
          .setName('delete_messages')
          .setDescription('Delete the user\'s recent messages when banning.')
          .setRequired(true),
      )
      .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Registering slash commands...');

    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });

    console.log('Slash commands registered successfully.');
  } catch (error) {
    console.error('Failed to register commands:', error);
    process.exit(1);
  }
})();
