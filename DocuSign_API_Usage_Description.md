# DocuSign API Usage Description

This document provides an overview of how our "Vote Counter & Form Data Aggregator" integrates with the DocuSign eSignature REST API. 

Our application acts as a background processor that monitors specific DocuSign templates (like Board Referendums and Case Presentations) to aggregate votes and manage the envelope lifecycle.

### Authentication
We use the **JWT (JSON Web Token) Grant OAuth flow** for server-to-server authentication. The application authenticates as a system user, allowing it to perform background tasks without requiring active user consent flows.

### Endpoints and Operations

1. **Fetching Envelopes (`GET /restapi/v2.1/accounts/{accountId}/envelopes`)**
   - **Purpose**: We periodically query the API to fetch a list of envelopes sent within a specific timeframe or matching certain criteria.
   - **Usage**: This allows us to discover new voting envelopes that have been sent out to users.

2. **Retrieving Form Data (`GET /restapi/v2.1/accounts/{accountId}/envelopes/{envelopeId}/form_data`)**
   - **Purpose**: Once an envelope is identified, we pull the form data to read the custom fields filled out by the recipients.
   - **Usage**: This is the core of our voting logic. We grab the checkboxes from the template and count them. We parse the form data to tally these choices (for example, counting checkboxes for *A Favor*, *No a Favor*, *Abstenido*) for each recipient.

3. **Voiding Envelopes (`PUT /restapi/v2.1/accounts/{accountId}/envelopes/{envelopeId}`)**
   - **Purpose**: Our system enforces strict voting deadlines.
   - **Usage**: When a predefined expiration time is reached, our background scheduler makes a request to void the envelope in DocuSign. We pass a `voidedReason` such as "Voting period has expired." This prevents any late voting and officially closes the referendum. The expiration time is dynamically determined by reading the following custom form fields from the DocuSign template: `Fecha Limite para votar`, `Hora limite votar`, `Minutos Limite para votar`, and `Meridiem Limite para votar`.

