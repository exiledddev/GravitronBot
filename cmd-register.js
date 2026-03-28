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

