import '~/styles/Global.scss';
import onceInit from '~/hooks/OnceInit.js';
import onceReady from '~/hooks/OnceReady.js';

Hooks.once('init', onceInit);
Hooks.once('ready', onceReady);
