"""Synthetic two-child routing, local persistence and prompt-contract checks."""
import copy
import json
from unittest import TestCase
from test_analysis import QueueTests, TEST_CONFIG, analysis, result

CHILD = {"id":"child-two", "child_name":"Børnehavebarn", "stage":"kindergarten",
         "institution_names":["Eksempel Børnehus"], "institution_codes":["nursery"],
         "profile_ids":[9002], "shared_institution_names":["Områdets fællesafsender"],
         "meal_plan":True}


class ChildRules(TestCase):
    def setUp(self):
        self.config = {**copy.deepcopy(TEST_CONFIG), "additional_children":[analysis.validate_child(CHILD)]}

    def match(self, kind, item):
        return [c['id'] for c in analysis.match_children(kind,item,self.config)]

    def test_school_child_and_kindergarten_child_have_separate_routes(self):
        self.assertEqual(self.match('post',{'institution':'Testskolen'}),['primary'])
        self.assertEqual(self.match('post',{'institution':'Eksempel Børnehus'}),['child-two'])
        self.assertEqual(self.match('post',{'institution':'  EKSEMPEL BØRNEHUS  '}),['child-two'])
        self.assertEqual(self.match('post',{'institution':'Et andet børnehus'}),[])
        self.assertEqual(self.match('post',{'institution':'Eksempel Børnehus Nord'}),[])
        self.assertEqual(self.match('post',{'institution':'Områdets fællesafsender'}),['child-two'])

    def test_child_profile_matches_after_institution_code_changes(self):
        self.assertEqual(self.match('thread',{'institutionCode':'new-unverified-code','regardingChildren':[{'profileId':9002}]}),['child-two'])
        self.assertEqual(self.match('thread',{'institutionCode':'nursery','regardingChildren':[{'profileId':9999}]}),[])
        self.assertEqual(self.match('thread',{'institutionCode':'nursery'}),['child-two'])
        self.assertEqual(self.match('thread',{'institutionCode':'123'}),['primary'])

    def test_missing_post_institution_goes_to_one_family_job_with_all_contexts(self):
        self.assertEqual(self.match('post',{}),['primary','child-two'])

    def test_prompt_states_meal_rules_exceptions_and_current_kindergarten(self):
        text=analysis.prompt({'source_id':'aula-post-1','institution':'Områdets fællesafsender'},self.config)
        for rule in ['barnet går i den angivne børnehave nu','medbring madpakke til turen',
                     'ren madplan','relevance none','egen drikkedunk','Ukendt børnehavegruppe må ikke gættes',
                     'Andre børnehuse','fælles','skiftetøj','svarfrister']:
            self.assertIn(rule,text)
        context=json.loads(text.split('FAMILIEKONTEKST:\n')[1].split('\nKILDEDATA:')[0])
        self.assertEqual(context['children'][1]['stage'],'kindergarten')
        self.assertTrue(context['children'][1]['meal_plan'])
        for value in [*TEST_CONFIG['phone_services'],'guardian_ids','profile_ids','9002']:
            self.assertNotIn(str(value),text)

    def test_invalid_context_is_rejected_before_persistence(self):
        for change in [{'id':'primary'},{'id':'../escape'},{'meal_plan':'yes'}, {'profile_ids':[True]},
                       {'institution_names':[]},{'stage':'unknown'}, {'phone_services':['somewhere']}]:
            with self.subTest(change=change),self.assertRaises(analysis.HomeAssistantError):
                analysis.validate_child({**CHILD,**change})


# Inherit the proven queue fixtures, without rerunning their inherited tests.
class FamilyQueue(QueueTests):
    async def test_upsert_preserves_existing_child_delivery_history_and_enabled_state(self):
        await self.manager.scan()
        before=copy.deepcopy(self.manager.data)
        await self.manager.control(False)
        await self.manager.upsert_child(CHILD)
        self.assertFalse(self.manager.data['enabled'])
        for key in ['records','since','last_scan']:
            self.assertEqual(self.manager.data[key],before[key])
        for key in TEST_CONFIG:self.assertEqual(self.manager.data['config'][key],TEST_CONFIG[key])
        self.assertEqual(len(self.calls('openclaw')),1)
        self.assertEqual(len(self.calls('notify')),2)
        await self.manager.start()
        self.assertEqual(self.manager.status()['children'][1]['id'],'child-two')
        self.assertNotIn('phone_services',self.manager.status()['children'][1])

    async def test_legacy_control_update_does_not_remove_added_child(self):
        await self.manager.upsert_child(CHILD)
        await self.manager.control(True,copy.deepcopy(TEST_CONFIG))
        self.assertEqual(len(self.manager.status()['children']),2)

    async def test_failing_save_rolls_back_child_change(self):
        before=copy.deepcopy(self.manager.data['config'])
        async def fail():raise OSError('disk')
        self.manager.save=fail
        with self.assertRaises(OSError):await self.manager.upsert_child(CHILD)
        self.assertEqual(self.manager.data['config'],before)

    async def test_shared_source_is_one_call_and_one_delivery_per_phone(self):
        await self.manager.upsert_child(CHILD)
        self.api.posts[0]['institution']=''
        await self.manager.scan();await self.manager.scan()
        self.assertEqual(len(self.calls('openclaw')),1)
        self.assertEqual(len(self.calls('notify')),2)
        self.assertEqual(next(iter(self.manager.data['records'].values()))['child_ids'],['child-two','primary'])

    async def test_new_child_does_not_reanalyse_existing_school_source(self):
        await self.manager.scan();await self.manager.upsert_child(CHILD);await self.manager.scan()
        self.assertEqual(len(self.calls('openclaw')),1)

    async def test_snapshot_new_code_is_followed_without_changing_parent_context_or_more_calls(self):
        await self.manager.upsert_child(CHILD)
        self.manager.coordinator.data={'sections':{'profiles':{'status':'ok','data':{
            'profiles':[{'children':[{'profileId':9002,'institutionCode':'new-code',
                                    'institutionProfile':{'institutionName':'Old label'}}]}]}}}}
        before=copy.deepcopy(self.manager.data['config'])
        routing=self.manager.routing_config()
        matches=analysis.match_children('thread',{'institutionCode':'new-code'},routing)
        self.assertEqual([c['id'] for c in matches],['child-two'])
        self.assertEqual(matches[0]['institution_names'],CHILD['institution_names'])
        self.assertEqual(self.manager.data['config'],before)
        self.assertFalse(self.api.calls)
        self.manager.coordinator.data['sections']['profiles']['stale']=True
        self.assertFalse(analysis.match_children('thread',{'institutionCode':'new-code'},self.manager.routing_config()))

    async def test_new_child_picks_up_previously_filtered_shared_area_post(self):
        self.api.posts[0]['institution']='Områdets fællesafsender'
        await self.manager.scan();self.assertFalse(self.calls('openclaw'))
        await self.manager.upsert_child(CHILD);await self.manager.scan()
        self.assertEqual(len(self.calls('openclaw')),1)
        sent=self.calls('openclaw')[0][2]['message']
        self.assertIn('Børnehavebarn',sent);self.assertNotIn('Testbarn',sent)

    async def test_rule_change_reanalyses_once_without_repeating_identical_push(self):
        self.api.posts[0]['institution']='Eksempel Børnehus'
        await self.manager.upsert_child(CHILD);await self.manager.scan()
        await self.manager.upsert_child({**CHILD,'meal_plan':False});await self.manager.scan();await self.manager.scan()
        self.assertEqual(len(self.calls('openclaw')),2)
        self.assertEqual(len(self.calls('notify')),2)

    async def test_test_source_respects_child_route_and_never_pushes(self):
        self.api.posts[0]['institution']='Et andet børnehus'
        with self.assertRaises(analysis.HomeAssistantError):await self.manager.test_source('post',1)
        self.assertFalse(self.calls('openclaw'))
        self.api.posts[0]['institution']='Eksempel Børnehus'
        await self.manager.upsert_child(CHILD);await self.manager.test_source('post',1)
        self.assertEqual(len(self.calls('openclaw')),1);self.assertFalse(self.calls('notify'))


for _name in list(QueueTests.__dict__):
    if _name.startswith('test_') and _name not in FamilyQueue.__dict__:
        setattr(FamilyQueue,_name,None)
del QueueTests
