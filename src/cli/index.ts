#!/usr/bin/env node
import { Command } from 'commander';
import { registerAddUser } from './commands/add-user.js';
import { registerListUsers } from './commands/list-users.js';
import { registerRemoveUser } from './commands/remove-user.js';

const program = new Command();

program.name('cognivault-ctl').description('CogniVault user management CLI').version('1.0.0');

registerAddUser(program);
registerRemoveUser(program);
registerListUsers(program);

program.parse();
