# MoviBox privacy notice

Maintainer: **blackridder22**  
Public privacy contact: **[br22.dev@gmail.com](mailto:br22.dev@gmail.com)**  
Country of operation: **United States**  
Effective date: **September 4, 2026**

This notice describes the official MoviBox desktop application and feedback submitted to its maintainers. It does not cover independently operated forks or the separate services you choose to connect.

## Information on your device

MoviBox stores settings, configured service and add-on addresses, account connection information, search activity, title metadata, download jobs and history, library file paths, monitoring rules, and diagnostic events locally. Downloaded videos and subtitles are written to the destinations you select.

Dedicated provider tokens and supported integration credentials are stored using the operating system's credential store. They are read into memory when needed to contact the relevant service. Your operating system may ask permission to provide a stored credential to MoviBox. MoviBox does not need your operating system login password as an application account password.

Local databases, caches, exported reports, and backups are not all encrypted by MoviBox. An add-on or custom service address may itself contain private configuration or credentials. Protect your device, OS account, backups, and files accordingly.

Portable MoviBox backups exclude dedicated integration credentials and private source URLs, but can include media titles, recent searches, watched markers, file paths, and automation settings. Treat a backup as personal information. Recovery copies and files you export remain in their selected locations until removed.

## Connections to other services

The app contacts services needed for the features you use. These can include Cinemeta and other Stremio-compatible add-ons; TorBox and Real-Debrid; TMDB; OpenSubtitles; configured indexers or local services; and hosts serving metadata, images, subtitles, or downloads.

Depending on the feature, a service may receive search terms, title or episode identifiers, torrent hashes or source links, file-selection requests, language preferences, authentication credentials for that service, and ordinary network information such as your IP address and request headers. Subtitle services can also receive a file hash, size, and original filename. The built-in Cinemeta catalog can be contacted without a separate provider login. Enabled monitoring and background jobs can make requests while the app is running, including when its main window is closed.

If you use a peer-to-peer transfer path, peers and trackers can receive your IP address and torrent activity. Direct and cloud-provider download paths involve the selected provider or file host instead. MoviBox does not make these connections anonymous.

Third-party services handle information under their own policies. Uninstalling MoviBox, clearing local history, or disconnecting a service does not delete the provider's records or cancel its subscription. Use that service's account controls for those actions.

## Optional feedback

Opening the feedback dialog or its browser fallback loads a form hosted by **Tally**. MoviBox supplies the app version and operating-system label in the form URL at that time. Tally receives the network information needed to serve the form before you submit it.

When you submit, Tally receives your answers and any screenshot or contact email you choose to provide. The form also records a submission identifier and time. Responses are copied to the maintainers' **Airtable** feedback base so they can investigate problems, prioritize improvements, and reply if you provided contact details.

No MoviBox account is required. Feedback is optional. MoviBox does not automatically attach provider keys, download history, private service URLs, or diagnostic logs to the form. Screenshots and text may contain anything you include, so remove credentials and other people's personal information before submitting. Not providing an email does not guarantee that the content of a response is anonymous.

Feedback is used for product improvement, troubleshooting, and responding to your request. It is not a marketing subscription. The maintainers do not sell feedback or use it for targeted advertising. They will not publish identifiable feedback, contact details, or screenshots as public GitHub issues without permission; a summary with identifying details removed may inform development work.

See [Tally's privacy policy](https://tally.so/help/privacy-policy) and [Airtable's privacy policy](https://www.airtable.com/company/privacy). Their infrastructure, subprocessors, retention, and international transfer arrangements also apply. Feedback may be accessed by the maintainer in the United States and processed in countries where those providers operate. Do not assume that both services store information in the same country. Where legally required, processing and transfers must use the providers' applicable data-processing agreements and safeguards; you may ask the privacy contact for information about them.

## Diagnostics and updates

MoviBox keeps diagnostic events locally for troubleshooting. Copying or exporting a diagnostic report is an explicit action; exporting alone does not send it to the maintainers. Review a report before sharing it. Redaction is not a guarantee that every free-text error message or file name is free of personal information.

Builds configured with a signed update feed can check it at startup and periodically when automatic checking is enabled, or when you request a check. The update host receives ordinary request metadata and information needed to select an update. This build currently has no update feed configured. Installing an update requires a separate action in the app.

The reviewed MoviBox interface does not include an automatic analytics or crash-report upload service. This is not a claim that connected providers, image hosts, GitHub, Tally, or Airtable make no logs of their own.

## Retention and deletion

Local information remains until you remove it through the app or delete its application data. Clearing history does not necessarily delete downloaded files, backups, provider records, or copies you exported. Removing the application alone may leave its data and OS credential entries behind. Disconnect accounts in Settings and revoke credentials at the provider if you no longer want them used.

Feedback is retained while needed to investigate the report, respond, maintain a relevant development record, or meet a specific legal or security obligation. Retention is reviewed manually, taking into account whether the report is resolved and whether identifying details are still needed. There is currently no automatic feedback-deletion schedule configured. Deletion requests and manual cleanup must cover **both Tally and Airtable**. Service backups and legal retention are governed by the relevant provider's arrangements.

You can request access, correction, or deletion of feedback using the privacy contact above. Include enough information to locate your response, such as its date or submission identifier, without sending a password or API key. If you submitted no contact information, the maintainer may need additional context to locate the response and verify the request.

Depending on applicable law, you may also have rights to object to processing, restrict processing, receive a portable copy, withdraw consent where processing relies on it, or complain to your local data-protection authority. Where a legal basis is required, ordinary feedback handling relies on the legitimate interests of understanding reports, improving the app, and answering requests; legally required records rely on the relevant legal obligation. **You may object to processing based on legitimate interests** by contacting the privacy address above. Consent will be requested for an additional use where required and can be withdrawn for that use.

Feedback is not used for solely automated decisions producing legal or similarly significant effects. You do not have to submit feedback to use MoviBox. Do not submit sensitive personal information or information about a child. If such information was submitted in error, contact the maintainer to request its removal.

## Security and changes

Access to feedback is limited to people who need it to maintain MoviBox and the providers processing it. Information may also be disclosed when required by law or necessary to respond to a specific security incident or legal claim. No application, device, or hosted service can promise absolute security. Report privacy or security issues to the contact above without including credentials or other unnecessary personal information.

Material changes to data handling will be explained in an updated notice with a new effective date. New integrations or processing purposes require a review of this notice before release.
