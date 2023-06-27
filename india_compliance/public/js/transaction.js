// functions in this file will apply to most transactions
// POS Invoice is a notable exception since it doesn't get created from the UI

const TRANSACTION_DOCTYPES = [
    "Quotation",
    "Sales Order",
    "Delivery Note",
    "Sales Invoice",
    "Purchase Order",
    "Purchase Receipt",
    "Purchase Invoice",
];

for (const doctype of TRANSACTION_DOCTYPES) {
    fetch_gst_details(doctype);
    validate_overseas_gst_category(doctype);

    if (frappe.boot.sales_doctypes.includes(doctype))
        set_and_validate_gstin_status(doctype, "billing_address_gstin");
    else set_and_validate_gstin_status(doctype, "supplier_gstin");
}

for (const doctype of ["Sales Invoice", "Delivery Note"]) {
    ignore_port_code_validation(doctype);
}

function fetch_gst_details(doctype) {
    const event_fields = ["tax_category", "company_gstin", "place_of_supply"];

    // we are using address below to prevent multiple event triggers
    if (in_list(frappe.boot.sales_doctypes, doctype)) {
        event_fields.push(
            "customer_address",
            "is_export_with_gst",
            "is_reverse_charge"
        );
    } else {
        event_fields.push("supplier_address");
    }

    const events = Object.fromEntries(
        event_fields.map(field => [field, frm => update_gst_details(frm, field)])
    );

    frappe.ui.form.on(doctype, events);
}

async function update_gst_details(frm, event) {
    if (
        frm.updating_party_details ||
        !frm.doc.company ||
        (event === "place_of_supply" && frm.__updating_gst_details)
    )
        return;

    const party_type = india_compliance.get_party_type(frm.doc.doctype).toLowerCase();
    const party_fieldname = frm.doc.doctype === "Quotation" ? "party_name" : party_type;
    const party = frm.doc[party_fieldname];
    if (!party) return;

    if (in_list(["company_gstin", "customer_address", "supplier_address"], event)) {
        frm.__update_place_of_supply = true;
    }

    if (frm.__gst_update_triggered) return;
    frm.__gst_update_triggered = true;

    const args = {
        doctype: frm.doc.doctype,
        company: frm.doc.company,
    };

    // wait for GSTINs to get fetched
    await frappe.after_ajax();

    // reset flags
    frm.__gst_update_triggered = false;

    if (frm.__update_place_of_supply) {
        args.update_place_of_supply = 1;
        frm.__update_place_of_supply = false;
    }

    const party_details = {};

    // set "customer" or "supplier" (not applicable for Quotations with Lead)
    if (frm.doc.doctype !== "Quotation" || frm.doc.party_type === "Customer") {
        party_details[party_type] = party;
    }

    const fieldnames_to_set = [
        "tax_category",
        "gst_category",
        "company_gstin",
        "place_of_supply",
    ];

    if (in_list(frappe.boot.sales_doctypes, frm.doc.doctype)) {
        fieldnames_to_set.push(
            "customer_address",
            "billing_address_gstin",
            "is_export_with_gst",
            "is_reverse_charge"
        );
    } else {
        fieldnames_to_set.push("supplier_address", "supplier_gstin");
    }

    for (const fieldname of fieldnames_to_set) {
        party_details[fieldname] = frm.doc[fieldname];
    }

    args.party_details = JSON.stringify(party_details);

    frappe.call({
        method: "india_compliance.gst_india.overrides.transaction.get_gst_details",
        args,
        async callback(r) {
            if (!r.message) return;

            frm.__updating_gst_details = true;
            await frm.set_value(r.message);
            frm.__updating_gst_details = false;
        },
    });
}

function validate_overseas_gst_category(doctype) {
    frappe.ui.form.on(doctype, {
        gst_category(frm) {
            const { enable_overseas_transactions } = gst_settings;
            if (!is_overseas_transaction(frm) || enable_overseas_transactions) return;

            frappe.throw(
                __("Please enable SEZ / Overseas transactions in GST Settings first")
            );
        },
    });
}

function is_overseas_transaction(frm) {
    if (frm.doc.gst_category === "SEZ") return true;

    if (frappe.boot.sales_doctypes) return is_foreign_transaction(frm);

    return frm.doc.gst_category === "Overseas";
}

function ignore_port_code_validation(doctype) {
    frappe.ui.form.on(doctype, {
        onload(frm) {
            frm.set_df_property("port_code", "ignore_validation", 1);
        },
    });
}

function is_foreign_transaction(frm) {
    return (
        frm.doc.gst_category === "Overseas" &&
        frm.doc.place_of_supply === "96-Other Countries"
    );
}

function set_and_validate_gstin_status(doctype, gstin_field_name) {
    frappe.ui.form.on(doctype, {
        [gstin_field_name](frm) {
            _set_and_validate_gstin_status(frm, gstin_field_name);
        },

        posting_date(frm) {
            if (frm.get_field("posting_date"))
                _set_and_validate_gstin_status(frm, gstin_field_name);
        },

        transaction_date(frm) {
            if (frm.get_field("transaction_date"))
                _set_and_validate_gstin_status(frm, gstin_field_name);
        },
    });
}

async function _set_and_validate_gstin_status(frm, gstin_field_name) {
    const date_field =
        frm.get_field("posting_date") || frm.get_field("transaction_date");

    const gstin_field = frm.get_field(gstin_field_name);
    const gstin = gstin_field.value;

    let gstin_doc;
    if (!frm._gstin_doc?.[gstin]) {
        gstin_doc = await india_compliance.set_gstin_status(gstin_field);

        frm._gstin_doc = frm._gstin_doc || {};
        frm._gstin_doc[gstin] = gstin_doc;
    } else {
        gstin_doc = frm._gstin_doc[gstin];
        gstin_field.set_description(
            india_compliance.get_gstin_status_desc(gstin_doc?.status)
        );
    }

    if (!gstin_doc) return;

    validate_gstin_status(gstin_doc, date_field, gstin_field);
}

function validate_gstin_status(gstin_doc, date_field, gstin_field) {
    transaction_date = frappe.datetime.str_to_obj(date_field.value);
    const registration_date = frappe.datetime.str_to_obj(gstin_doc.registration_date);
    const cancelled_date = frappe.datetime.str_to_obj(gstin_doc.cancelled_date);

    if (!registration_date || transaction_date < registration_date)
        frappe.throw({
            message: __(
                "{0} is Registered on {1}. Please make sure that the {2} is on or after {1}",
                [
                    gstin_field.df.label,
                    frappe.datetime.str_to_user(gstin_doc.registration_date),
                    date_field.df.label,
                ]
            ),
            title: __("Invalid Party GSTIN"),
        });

    if (gstin_doc.status === "Cancelled" && transaction_date >= cancelled_date)
        frappe.throw({
            message: __(
                "{0} is Cancelled from {1}. Please make sure that the {2} is before {1}",
                [
                    gstin_field.df.label,
                    frappe.datetime.str_to_user(gstin_doc.cancelled_date),
                    date_field.df.label,
                ]
            ),
            title: __("Invalid Party GSTIN"),
        });

    if (!["Active", "Cancelled"].includes(gstin_doc.status))
        frappe.throw({
            message: __("Status of {0} is {1}", [
                gstin_field.df.label,
                gstin_doc.status,
            ]),
            title: __("Invalid GSTIN Status"),
        });
}
