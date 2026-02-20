import { BARK_KEY_DEFAULT } from './constant';
import { syncGarminGlobal2GarminCN } from './utils/garmin_global';

const axios = require('axios');
const core = require('@actions/core');
const BARK_KEY = process.env.BARK_KEY ?? BARK_KEY_DEFAULT;

async function main() {
    try {
        await syncGarminGlobal2GarminCN();
    } catch (e) {
        if (e.message?.includes('MFA_REQUESTED')) {
            console.log('MFA flow triggered, skipping failure notification');
        } else {
            await axios.get(
                `https://api.day.app/${BARK_KEY}/Garmin CN -> Garmin Global 同步数据运行失败了，快去检查！/${e.message}`);
        }
        core.setFailed(e.message);
        throw e;
    }
}

main();




