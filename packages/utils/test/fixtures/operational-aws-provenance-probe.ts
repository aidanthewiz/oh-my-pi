import { getOperationalAwsLaunchMetadata } from "../../src/env";

const metadata = getOperationalAwsLaunchMetadata();
process.stdout.write(JSON.stringify({ metadata, cached: metadata === getOperationalAwsLaunchMetadata() }));
