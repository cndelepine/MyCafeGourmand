#!/usr/bin/env node

import {
  contactFormEndpointEnvironmentVariable,
  requireContactFormEndpoint
} from "../src/lib/contact-form";

try {
  const endpoint = requireContactFormEndpoint();
  console.log(
    `Validated release contact form endpoint: ${contactFormEndpointEnvironmentVariable}=${endpoint.href}`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`release-contact-form-validation-failed: ${message}`);
  process.exitCode = 1;
}
