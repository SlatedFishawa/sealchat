package service

import (
	"sealchat/model"
	"sealchat/pkg/ttsprovider"
)

// TTSRoleQuickState resolves the same provider, voice and defaults as a new
// automatic message. It performs no synthesis and never writes the binding.
type TTSRoleQuickState struct {
	Disabled     bool             `json:"disabled"`
	VoiceName    string           `json:"voiceName"`
	ProviderKind string           `json:"providerKind"`
	ModelID      string           `json:"modelId"`
	Parameters   TTSQuickOverride `json:"parameters"`
}

func TTSResolveRoleQuickState(userID, identityID string) (*TTSRoleQuickState, error) {
	role, err := TTSRoleConfig(userID, identityID)
	if err != nil {
		return nil, err
	}
	if role.Disabled {
		return &TTSRoleQuickState{Disabled: true, VoiceName: "角色未绑定音色"}, nil
	}
	s, err := ttsSnapshotForRequest(userID, TTSRequest{
		VoiceID: role.VoiceID, SystemVoice: role.SystemVoice,
		SystemVoiceProvider: role.SystemVoiceProvider, SystemVoiceProviderID: role.SystemVoiceProviderID,
		SystemVoiceModel: role.SystemVoiceModel, SpeechLanguage: role.SpeechLanguage,
		Rate: role.Rate, Pitch: role.Pitch, Volume: &role.Volume, Instruction: role.Instruction,
	}, "role-quick", true)
	if err != nil {
		return nil, err
	}
	name := s.Input.Voice
	if role.VoiceID != "" {
		voice, voiceErr := ttsAccessibleVoice(model.GetDB(), userID, role.VoiceID)
		if voiceErr != nil {
			return nil, voiceErr
		}
		name = voice.Name
	} else {
		for _, voice := range ttsprovider.VoiceCatalog() {
			if voice.ID == s.Input.Voice && voice.ProviderKind == s.Provider.EffectiveProviderKind() {
				name = voice.Name
				break
			}
		}
		if voice, ok := ttsMPSSystemVoice(s.Provider, s.Provider.Model, s.Input.Voice); ok {
			name = voice.Name
		}
	}
	return &TTSRoleQuickState{
		VoiceName: name, ProviderKind: s.Provider.EffectiveProviderKind(), ModelID: s.Provider.Model,
		Parameters: TTSQuickOverride{Rate: &s.Input.Rate, Pitch: &s.Input.Pitch, Volume: &s.Input.Volume, Instruction: &s.Input.Instruction},
	}, nil
}
