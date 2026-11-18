# Configuration list

Everything Veritek can change without a developer, where it is changed, and the proposed pilot default.
Changes are audited (Settings → Audit log). Environment variables are in [setup.md](setup.md).

## Settings

### company

*Changed in:* Settings → Company & commercial → Company profile

| Key | Default |
|---|---|
| `name` | `Veritek Engineering Private Limited` |
| `short` | `VERITEK` |
| `gstin` | *(blank)* |
| `address` | *(blank)* |
| `phone` | *(blank)* |
| `email` | *(blank)* |
| `website` | `www.veritekindia.com` |
| `currency` | `INR` |
| `fiscalYearStartMonth` | `4` |

### calendar

*Changed in:* Settings → Calendar & rules → Working calendar

| Key | Default |
|---|---|
| `timezone` | `Asia/Kolkata` |
| `workingDays` | `[1,2,3,4,5,6]` |
| `holidays` | `[]` |
| `workStart` | `09:30` |
| `workEnd` | `18:30` |

### rules

*Changed in:* Settings → Calendar & rules → Reminder & alert rules

| Key | Default |
|---|---|
| `dormantDays` | `180` |
| `staleWorkingDays` | `2` |
| `readyGraceWorkingDays` | `1` |
| `enquiryResponseWorkingDays` | `1` |
| `pipelineQuoteDraftWorkingDays` | `2` |
| `pipelineQuoteDecisionWorkingDays` | `5` |
| `pipelineConfirmationWorkingDays` | `2` |
| `pipelineAdvanceWorkingDays` | `3` |
| `escalateAfterWorkingDays` | `1` |
| `reactivationDailyCapPerOwner` | `5` |
| `noteMaxLength` | `1000` |

### reminders

*Changed in:* Settings → Company & commercial → Sales reminders

| Key | Default |
|---|---|
| `quotationFollowupWorkingDays` | `3` |
| `quotationExpiryWarnDays` | `3` |
| `sampleFeedbackDays` | `5` |
| `repeatOrderEnabled` | `true` |
| `repeatOrderMinOrders` | `2` |
| `paymentReminderDays` | `0` |
| `managementSummaries` | `true` |

### access

*Changed in:* Settings → Calendar & rules → Access policy

| Key | Default |
|---|---|
| `salesScope` | `own` |
| `coordinatorMode` | `true` |
| `productionSeesValues` | `false` |
| `dncPolicy` | `warn` |
| `autoAssignEnquiries` | `true` |

### approvals

*Changed in:* Settings → Company & commercial → Quotation approvals

| Key | Default |
|---|---|
| `discountManagerPct` | `10` |
| `discountHeadPct` | `18` |
| `minMarginPct` | `22` |
| `belowMinPriceRole` | `management` |
| `largeQuotationValue` | `2500000` |
| `requireBeforeIssue` | `true` |

### quotation

*Changed in:* Settings → Company & commercial → Quotation defaults

| Key | Default |
|---|---|
| `defaultValidityDays` | `30` |
| `defaultPaymentTerms` | `30% advance, balance against proforma before dispatch` |
| `defaultWarranty` | `18 months from supply or 12 months from commissioning, whichever is earlier` |
| `defaultDelivery` | `3-4 weeks from receipt of technically and commercially clear PO` |
| `freightGstRate` | `18` |

### objects

*Changed in:* Settings → Company & commercial → QR codes & scan pages

| Key | Default |
|---|---|
| `publicBaseUrl` | *(blank)* |
| `labelShowName` | `true` |
| `labelShowId` | `true` |
| `labelShowCompany` | `true` |
| `brandColor` | `#3f1069` |
| `archivedMessage` | `This item has been archived and is no longer published.` |

### escalation

*Changed in:* Settings → Calendar & rules → Access policy (default escalation manager)

| Key | Default |
|---|---|
| `defaultManagerId` | `null` |

### finance

*Changed in:* Payments → Data as of

| Key | Default |
|---|---|
| `asOf` | `null` |
| `reconciliation` | `not_reconciled` |
| `source` | `Manual entry` |

### scheduler

*Changed in:* Settings → Calendar & rules → Scheduler & backups

| Key | Default |
|---|---|
| `enabled` | `true` |
| `intervalMinutes` | `15` |

### backup

*Changed in:* Settings → Calendar & rules → Scheduler & backups

| Key | Default |
|---|---|
| `enabled` | `true` |
| `keep` | `14` |
| `hour` | `2` |


## Dropdown lists

Settings → Dropdowns. Codes are stable; labels can be renamed, values added, and used values deactivated
(never deleted). *(note)* marks values that ask for a short explanation.

| List | Values |
|---|---|
| Enquiry source <br><sub>`enquiry_source`</sub> | Existing customer, Website, WhatsApp, Email, Exhibition, Field visit, Dealer / referral, Outbound, IndiaMART / online portal, Tender, Event / campaign, Other *(note)*, Unknown |
| Lost / no-purchase reason <br><sub>`lost_reason`</sub> | Price, Delivery time, Specification / feature mismatch, Certification / approval requirement, Competitor selected, Project postponed, Project cancelled, No current requirement, No response, Credit / payment terms, Unknown, Other *(note)* |
| Win reason <br><sub>`win_reason`</sub> | Technical superiority, Competitive price, Faster delivery, Existing relationship, Service support, Brand reputation, Approved vendor, Other *(note)* |
| Enquiry cancellation reason <br><sub>`enquiry_cancel_reason`</sub> | Withdrawn by customer, Duplicate enquiry, Invalid / spam, Other *(note)* |
| Contact outcome <br><sub>`contact_outcome`</sub> | No answer, Requested callback, Requirement confirmed, Quotation requested, Quotation discussed, Price concern, Delivery concern, Specification clarification, Sample / catalogue shared, Waiting for customer, Order confirmed, Not interested, Other *(note)* |
| Customer response to a date change <br><sub>`customer_update_outcome`</sub> | Informed — awaiting response, Customer accepted revised date, Customer requested earlier dispatch, Partial dispatch agreed, Customer considering cancellation, Customer cancelled, Other *(note)* |
| Delay reason <br><sub>`delay_reason`</sub> | Raw material shortage, Staff shortage, Machine / tool issue, Technical clarification, Quality / rework issue, Other work prioritised, Customer approval pending, Payment hold, Other *(note)* |
| Order cancellation reason <br><sub>`cancel_reason`</sub> | Customer cancelled, Project cancelled, Delivery delay, Specification change, Payment issue, Duplicate entry, Other *(note)* |
| Reconnect action <br><sub>`reactivation_action`</sub> | Call, Email, Revised quote, Product update, Ask for feedback, Other *(note)* |
| Reason for not pursuing <br><sub>`reactivation_close_reason`</sub> | No further potential, Business closed / moved, Asked not to be contacted, Served through a dealer, Other *(note)* |
| Contact channel <br><sub>`channel`</sub> | Phone call, WhatsApp, Email, Meeting / visit, Video call, Factory visit, Exhibition, Internal note (not customer contact), Other *(note)* |
| Customer type <br><sub>`customer_type`</sub> | Manufacturer, OEM, Panel builder, Dealer, Distributor, Contractor, Consultant, System integrator, EPC, Government / PSU, End user, Other |
| Unit of measure <br><sub>`unit`</sub> | Pieces, Sets, Metres, Kilograms, Lot |
| Direct order source <br><sub>`order_source`</sub> | Repeat order, Purchase order without tracked enquiry, Replacement / warranty, Verbal / phone order, Other *(note)* |
| Complaint category <br><sub>`complaint_category`</sub> | Reading / accuracy, Display, Communication, Physical damage, Installation / application, Delivery / quantity, Documentation, Other *(note)* |
| Complaint resolution action <br><sub>`complaint_resolution`</sub> | Technical guidance, Repair, Replacement, Return accepted, Firmware update / reconfiguration, Commercial resolution, No product fault identified, Other *(note)* |
| Confirmed root cause <br><sub>`complaint_root_cause`</sub> | Component failure, Workmanship, Design / firmware, Transit damage, Application / installation, Supplier material, No fault found, Other *(note)* |

## Master lists

| List | Changed in | Notes |
|---|---|---|
| Sales regions (with their states) | Settings → Regions, factories & rules | A customer's state places it in a region; regional managers see their region |
| Factories | Settings → Regions, factories & rules | Production and QC users see orders for their factory |
| Enquiry assignment rules | Settings → Regions, factories & rules | Owner for new enquiries by region, product family and market (lowest priority number first) |
| Customer tags | Settings → Regions, factories & rules | Also created on the fly from a customer's tag field |
| Product categories, products, options, documents | Products & prices | Categories are the product families used in filters, rules and reports |
| Exhibitions | Exhibitions | Exhibitions and events, the customers met there and the enquiries linked to them |
| Object categories & field templates | Objects & QR → Categories | Pre-fill custom fields on new objects |
| People, roles, regions, factories | Settings → People & access | One account per person; named owners without sign-in |
| Monthly sales targets | Team & approvals → Targets | Per person and month, in the reporting currency |
