import { getGaminCNClient } from './src/utils/garmin_cn';
import { getGaminGlobalClient } from './src/utils/garmin_global';

async function test() {
    try {
        console.log("CN...");
        const clientCN = await getGaminCNClient();
        console.log("Global...");
        const clientGlobal = await getGaminGlobalClient();

        console.log("CN activities");
        await clientCN.getActivities(0, 1);
        console.log("Global activities");
        await clientGlobal.getActivities(0, 1);
    } catch(e) {
        console.error(e);
    }
}
test();
