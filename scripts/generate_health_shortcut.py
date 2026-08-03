import plistlib
import uuid

def new_uuid():
    return str(uuid.uuid4()).upper()

def token_string(text=None, attachment=None):
    """Build a WFTextTokenString dict."""
    if attachment is None:
        return {"Value": {"string": text or ""}, "WFSerializationType": "WFTextTokenString"}
    return {
        "Value": {"string": text or "\ufffc", "attachmentsByRange": {"{0, 1}": attachment}},
        "WFSerializationType": "WFTextTokenString"
    }

def action_output_token(output_uuid, output_name, aggrandizements=None):
    att = {"Type": "ActionOutput", "OutputUUID": output_uuid, "OutputName": output_name}
    if aggrandizements:
        att["Aggrandizements"] = aggrandizements
    return token_string(attachment=att)

def variable_token(var_name):
    return token_string(attachment={"Type": "Variable", "VariableName": var_name})

def find_health_samples_today(sample_type, output_uuid):
    """Find Health Samples: type = sample_type, start date = today/last 1 day."""
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.filter.health.quantity",
        "WFWorkflowActionParameters": {
            "UUID": output_uuid,
            "WFContentItemFilter": {
                "Value": {
                    "WFActionParameterFilterPrefix": 1,
                    "WFActionParameterFilterTemplates": [
                        {
                            "Property": "Type",
                            "Operator": 4,
                            "Values": {
                                "Enumeration": {
                                    "Value": sample_type,
                                    "WFSerializationType": "WFStringSubstitutableState"
                                }
                            },
                            "Removable": False,
                            "Bounded": True,
                        },
                        {
                            "Property": "Start Date",
                            "Operator": 1002,
                            "Values": {
                                "Unit": {
                                    "Value": 16,
                                    "WFSerializationType": "WFCalendarUnitSubstitutableState"
                                },
                                "Number": {
                                    "Value": "1",
                                    "WFSerializationType": "WFNumberStringSubstitutableState"
                                }
                            },
                            "Removable": False,
                            "Bounded": True,
                        }
                    ],
                    "WFContentPredicateBoundedDate": False,
                },
                "WFSerializationType": "WFContentPredicateTableTemplate"
            }
        }
    }

def statistics_sum(input_uuid, output_uuid, input_name="Health Samples"):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.statistics",
        "WFWorkflowActionParameters": {
            "UUID": output_uuid,
            "WFInput": {
                "Value": {
                    "Type": "ActionOutput",
                    "OutputUUID": input_uuid,
                    "OutputName": input_name
                },
                "WFSerializationType": "WFTextTokenAttachment"
            },
            "WFStatisticsOperation": "Sum"
        }
    }

def set_variable(input_uuid, var_name, input_name="Sum"):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.appendvariable",
        "WFWorkflowActionParameters": {
            "WFInput": {
                "Value": {
                    "Type": "ActionOutput",
                    "OutputUUID": input_uuid,
                    "OutputName": input_name
                },
                "WFSerializationType": "WFTextTokenAttachment"
            },
            "WFVariableName": var_name
        }
    }

def round_number(input_uuid, output_uuid, input_name="Sum"):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.round",
        "WFWorkflowActionParameters": {
            "UUID": output_uuid,
            "WFInput": {
                "Value": {
                    "Type": "ActionOutput",
                    "OutputUUID": input_uuid,
                    "OutputName": input_name
                },
                "WFSerializationType": "WFTextTokenAttachment"
            },
            "WFRoundTo": "Ones Place"
        }
    }

def math_multiply(input_uuid, operand, output_uuid, input_name="Sum"):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.math",
        "WFWorkflowActionParameters": {
            "UUID": output_uuid,
            "WFInput": {
                "Value": {
                    "Type": "ActionOutput",
                    "OutputUUID": input_uuid,
                    "OutputName": input_name
                },
                "WFSerializationType": "WFTextTokenAttachment"
            },
            "WFMathOperation": "×",
            "WFMathOperand": operand
        }
    }

def date_action(output_uuid):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.date",
        "WFWorkflowActionParameters": {"UUID": output_uuid}
    }

def format_date_iso(date_uuid, output_uuid):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.format.date",
        "WFWorkflowActionParameters": {
            "UUID": output_uuid,
            "WFDate": action_output_token(
                date_uuid,
                "Date",
                aggrandizements=[
                    {
                        "Type": "WFDateFormatVariableAggrandizement",
                        "WFDateFormatStyle": "ISO 8601",
                        "WFISO8601IncludeTime": False
                    }
                ]
            )
        }
    }

def text_action_with_formatted_date(date_uuid, output_uuid):
    """Text action containing the formatted date as ISO string."""
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
        "WFWorkflowActionParameters": {
            "UUID": output_uuid,
            "WFTextActionText": action_output_token(
                date_uuid,
                "Formatted Date",
                aggrandizements=[
                    {
                        "CoercionItemClass": "WFDateContentItem",
                        "Type": "WFCoercionVariableAggrandizement"
                    },
                    {
                        "Type": "WFDateFormatVariableAggrandizement",
                        "WFDateFormatStyle": "ISO 8601",
                        "WFISO8601IncludeTime": False
                    }
                ]
            )
        }
    }

def post_json(url, date_text_uuid, variables, output_uuid):
    """POST nested dict {date, steps, active_energy_kj, distance_km}."""
    items = []
    items.append({
        "WFItemType": 0,
        "WFKey": token_string("date"),
        "WFValue": action_output_token(date_text_uuid, "Text")
    })
    for key, var_name in variables:
        items.append({
            "WFItemType": 0,
            "WFKey": token_string(key),
            "WFValue": variable_token(var_name)
        })
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
        "WFWorkflowActionParameters": {
            "UUID": output_uuid,
            "WFURL": token_string(url),
            "WFHTTPMethod": "POST",
            "WFHTTPHeaders": {
                "Value": {
                    "WFDictionaryFieldValueItems": [
                        {
                            "WFItemType": 0,
                            "WFKey": token_string("Content-Type"),
                            "WFValue": token_string("application/json")
                        }
                    ]
                },
                "WFSerializationType": "WFDictionaryFieldValue"
            },
            "WFJSONValues": {
                "Value": {"WFDictionaryFieldValueItems": items},
                "WFSerializationType": "WFDictionaryFieldValue"
            }
        }
    }

def build_steps_only():
    actions = []

    # Steps: Find -> Sum -> Round -> Variable
    u_find = new_uuid()
    u_sum = new_uuid()
    u_round = new_uuid()
    actions.append(find_health_samples_today("Step Count", u_find))
    actions.append(statistics_sum(u_find, u_sum))
    actions.append(round_number(u_sum, u_round))
    actions.append(set_variable(u_round, "steps", input_name="Rounded Number"))

    # Date -> Format ISO -> Text -> Variable
    u_date = new_uuid()
    u_fmt = new_uuid()
    u_text = new_uuid()
    actions.append(date_action(u_date))
    actions.append(format_date_iso(u_date, u_fmt))
    actions.append(text_action_with_formatted_date(u_fmt, u_text))
    actions.append(set_variable(u_text, "date_str", input_name="Text"))

    # POST
    u_post = new_uuid()
    actions.append(post_json(
        "http://BarbaradeMac-mini.local:61023/api/healthkit/ingest",
        u_text,
        [("steps", "steps")],
        u_post
    ))

    return {
        "WFWorkflowActions": actions,
        "WFWorkflowClientVersion": "2700.0.4",
        "WFWorkflowClientRelease": "5.0",
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowIcon": {"WFWorkflowIconGlyphNumber": 61456, "WFWorkflowIconStartColor": 4292093695},
        "WFWorkflowImportQuestions": [],
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowName": "Sync Steps to Sleep Tracker v3",
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowTypes": ["NCWidget"],
    }

if __name__ == "__main__":
    sc = build_steps_only()
    out = "/Users/barbara/Downloads/Sync-Steps-to-Sleep-Tracker-v3.shortcut"
    with open(out, "wb") as f:
        plistlib.dump(sc, f, fmt=plistlib.FMT_BINARY)
    print("written", out)
