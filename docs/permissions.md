# Permission matrix

Generated from `shared/constants.js` — the same table the server enforces on every request, list,
file download and export. The browser only mirrors it to hide buttons a role cannot use.

**Record scope** limits *which* records a role sees, on top of what it may do:

| Role | Group | Scope | Meaning |
|---|---|---|---|
| Super admin | admin | all | Every customer and order |
| Management | admin | all | Every customer and order |
| Data coordinator | coordinator | all | Every customer and order |
| Sales head | sales | all | Every customer and order |
| Regional sales manager | sales | region | Customers in their sales region (and their own work) |
| Sales / export executive | sales | own | Customers and work they own (all customers if Settings → Access says so) |
| Quotation / commercial | sales | all | Every customer and order |
| Production | production | factory | Confirmed orders at their factory (or with no factory yet) |
| Quality / QC | production | factory | Confirmed orders at their factory (or with no factory yet) |
| Dispatch | production | all | Every customer and order |
| Accounts | accounts | all | Every customer and order |
| Service | service | all | Every customer and order |
| Read-only management | viewer | all | Every customer and order |
| Named owner (no sign-in) | staff | — | Cannot sign in; can own tasks that the coordinator records on their behalf |

**Value redaction**: roles without *Commercial values* never receive prices or order values from the API
(not just hidden in the page); without *Margin & cost* they never receive cost, margin or minimum price;
without *Full finance detail* they never receive TDS, deductions, credit limits or bank references.

✓ = allowed.


## Overview & dashboards

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Overview (exceptions first) <br><sub>`dashboard.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Sales dashboard <br><sub>`analytics.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  | ✓ |
| Coordinator work queue <br><sub>`queue.view`</sub> | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |
| Pin records to the overview <br><sub>`pins.manage`</sub> | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  | ✓ |

## Customers

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View customers <br><sub>`customers.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create / edit customers <br><sub>`customers.edit`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  | ✓ |  |  |
| Merge duplicate customers <br><sub>`customers.merge`</sub> | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| Archive customers <br><sub>`customers.archive`</sub> | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| Past customers <br><sub>`past.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ |
| Reactivation work <br><sub>`past.edit`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |

## Enquiries & tasks

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View enquiries <br><sub>`enquiries.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ |
| Create / update enquiries <br><sub>`enquiries.edit`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| Own follow-ups <br><sub>`tasks.edit`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| Manage anyone's follow-ups <br><sub>`tasks.manage_any`</sub> | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| Record activities <br><sub>`activities.edit`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |

## Quotations

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View quotations <br><sub>`quotes.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ |
| Build and issue quotations <br><sub>`quotes.edit`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| Approve discounts / margins <br><sub>`quotes.approve`</sub> | ✓ | ✓ |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| Convert an expired quotation <br><sub>`quotes.expired_override`</sub> | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |

## Orders & production

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View orders <br><sub>`orders.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create / confirm orders <br><sub>`orders.edit`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| Production updates <br><sub>`orders.update`</sub> | ✓ | ✓ | ✓ |  |  |  |  | ✓ | ✓ | ✓ |  |  |  |
| Record customer communication <br><sub>`orders.communicate`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| Amend confirmed quantities / specs <br><sub>`orders.amend`</sub> | ✓ | ✓ | ✓ |  |  |  | ✓ |  |  |  |  |  |  |
| Cancel quantities <br><sub>`orders.cancel`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| Reopen / undo cancellations <br><sub>`orders.authorise`</sub> | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| Pass QC (QC → ready) <br><sub>`qc.pass`</sub> | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ |  |  |  |  |

## Dispatch

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Post dispatches <br><sub>`dispatch.post`</sub> | ✓ | ✓ | ✓ |  |  |  |  | ✓ |  | ✓ |  |  |  |
| Dispatch quantity not recorded as ready <br><sub>`dispatch.override`</sub> | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |
| Reverse a dispatch <br><sub>`dispatch.reverse`</sub> | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |

## Commercial values

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| See prices and order values <br><sub>`values.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ |
| See cost and margin <br><sub>`margin.view`</sub> | ✓ | ✓ |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| See TDS, deductions and credit limits <br><sub>`finance.full`</sub> | ✓ | ✓ |  | ✓ |  |  |  |  |  |  | ✓ |  |  |

## Payments

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View invoices and receipts <br><sub>`finance.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ |
| Record invoices and receipts <br><sub>`finance.edit`</sub> | ✓ | ✓ |  |  |  |  |  |  |  |  | ✓ |  |  |
| Payment holds <br><sub>`finance.holds`</sub> | ✓ | ✓ |  |  |  |  |  |  |  |  | ✓ |  |  |

## Complaints

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View complaints <br><sub>`complaints.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Handle complaints <br><sub>`complaints.edit`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |  |

## Products, campaigns, objects

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| View products & price list <br><sub>`products.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit products & prices <br><sub>`products.edit`</sub> | ✓ | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |
| View campaigns <br><sub>`campaigns.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ |
| Manage campaigns <br><sub>`campaigns.edit`</sub> | ✓ | ✓ |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| View objects & QR <br><sub>`objects.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit objects & QR <br><sub>`objects.edit`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| Delete objects / templates <br><sub>`objects.manage`</sub> | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |

## Team, reports, data

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Team, approvals & targets <br><sub>`team.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |  | ✓ |
| Set sales targets <br><sub>`targets.edit`</sub> | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |  |  |  |
| Reports <br><sub>`reports.view`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  | ✓ |
| Export lists <br><sub>`export.lists`</sub> | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  | ✓ |
| Full data export <br><sub>`export.full`</sub> | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| Run imports <br><sub>`imports.run`</sub> | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |
| Upload documents <br><sub>`attachments.upload`</sub> | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |

## Administration

| Permission | Super admin | Management | Data coordinator | Sales head | Regional sales manager | Sales / export executive | Quotation / commercial | Production | Quality / QC | Dispatch | Accounts | Service | Read-only management |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Users and access <br><sub>`users.manage`</sub> | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| Settings <br><sub>`settings.manage`</sub> | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| Audit trail <br><sub>`audit.view`</sub> | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |

Production and service users can additionally be allowed to see commercial values per person
(Settings → People → “May see commercial values”) or for everyone (Settings → Access).
