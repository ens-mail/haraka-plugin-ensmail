# haraka-plugin-ensmail

`ensmail` is a plugin that implement ENS MX Protocol. A mail will be forwarded to another mail according to ENS records, received to a mail storage, or rejected.

## Configuration

The receiving mode and RPC node can be set by altering the content of `config/ens/ens.ini`.

- `mode`: Possible values are `FORWARD` and `RECEIVE`
  - `FORWARD` (Default): This server won't store any mail. If the recipient's `deliverTo` is this server it leads to a reject.
  - `RECEIVE`: A mail will be received and stored if the recipient's `deliverTo` is this server.
- `rpc_url` (Required): The RPC node that be used to query ENS records
- `mail_template_path` (Default: `./config/ens/templates/`): The path where the mail templates are

### Mail Template Variables

Please refer to [Handlebars Documentation](https://handlebarsjs.com/) for variables usage.

#### Reject

- `{{ sender }}`: The mail sender's email address
- `{{ recipient }}`: The mail recipient's ENS name
- `{{ reason }}`: The reason why mail was reject, for example
  - `This ENS name not exists`
  - `This ENS didn't set the destination`
  - `Canonical loop exists`
  - `Can't receive to this server because this server is forward only`
- `{{ info }}`: The processing information, for example

```
Lookup destination for limao.eth with MX record
No MX record found, lookup with global key `email`
No `email` record, no destination
```
